import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

/**
 * Object storage (docs/03 §7). Buckets are modelled as key prefixes:
 * `uploads/<projectId>/…` (private, per-project), `scenes/<projectId>/…`
 * (derived bundles), `catalog/…` (public, immutable).
 *
 * Uploads go direct-to-storage via presigned URLs — the API issues the URL and
 * the browser PUTs the bytes (docs/03 §3: "the API never proxies file bytes").
 * The in-memory driver below is the dev/CI implementation; it signs URLs the
 * same way and is served by the API's own `/v1/blobs` route, which is the only
 * place bytes and the API share a process.
 */
export interface PresignedUpload {
  uploadUrl: string;
  method: "PUT";
  headers: Record<string, string>;
  expiresAt: string;
  storageRef: string;
}

export interface Blobs {
  presignPut(key: string, contentType: string, ttlSeconds?: number): Promise<PresignedUpload>;
  /** 15-minute presigned GET (docs/03 §7) */
  presignGet(key: string, ttlSeconds?: number): Promise<string>;
  verify(key: string, expires: number, signature: string): boolean;
  put(key: string, bytes: Uint8Array): Promise<void>;
  get(key: string): Promise<Uint8Array | undefined>;
  /** Purge every object under a prefix; returns how many were removed. */
  deletePrefix(prefix: string): Promise<number>;
  list(prefix: string): Promise<string[]>;
}

const PRESIGN_TTL = 15 * 60;

export function createMemoryBlobs(baseUrl = ""): Blobs {
  const objects = new Map<string, Uint8Array>();
  const key = randomBytes(32);

  const sign = (objectKey: string, expires: number) =>
    createHmac("sha256", key).update(`${objectKey}:${expires}`).digest("hex");

  return {
    async presignPut(objectKey, contentType, ttlSeconds = PRESIGN_TTL) {
      const expires = Math.floor(Date.now() / 1000) + ttlSeconds;
      const sig = sign(objectKey, expires);
      return {
        uploadUrl: `${baseUrl}/v1/blobs/${encodeURIComponent(objectKey)}?expires=${expires}&sig=${sig}`,
        method: "PUT",
        headers: { "content-type": contentType },
        expiresAt: new Date(expires * 1000).toISOString(),
        storageRef: objectKey,
      };
    },
    async presignGet(objectKey, ttlSeconds = PRESIGN_TTL) {
      const expires = Math.floor(Date.now() / 1000) + ttlSeconds;
      return `${baseUrl}/v1/blobs/${encodeURIComponent(objectKey)}?expires=${expires}&sig=${sign(objectKey, expires)}`;
    },
    verify(objectKey, expires, signature) {
      if (!Number.isFinite(expires) || expires * 1000 < Date.now()) return false;
      const expected = Buffer.from(sign(objectKey, expires), "utf8");
      const given = Buffer.from(signature, "utf8");
      return expected.length === given.length && timingSafeEqual(expected, given);
    },
    async put(objectKey, bytes) {
      objects.set(objectKey, bytes);
    },
    async get(objectKey) {
      return objects.get(objectKey);
    },
    async deletePrefix(prefix) {
      let removed = 0;
      for (const k of [...objects.keys()]) {
        if (k.startsWith(prefix)) {
          objects.delete(k);
          removed++;
        }
      }
      return removed;
    },
    async list(prefix) {
      return [...objects.keys()].filter((k) => k.startsWith(prefix));
    },
  };
}
