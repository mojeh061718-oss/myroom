import type { FastifyInstance } from "fastify";
import { createHash } from "node:crypto";
import { CreateUploadBody, UPLOAD_LIMITS, type Upload } from "@myroom/schema";
import type { Store } from "../store.js";
import type { Blobs } from "../blobs.js";
import { checkUpload, extensionOf } from "../uploads/magic.js";
import { conflict, invalid, notFound, problem } from "../problem.js";

/**
 * Upload routes (docs/03 §3). Bytes go direct to storage through a presigned
 * URL; the API only mints the URL and, on `/complete`, verifies what landed:
 * declared hash, declared size, and magic bytes.
 */
export function registerUploadRoutes(
  app: FastifyInstance,
  deps: {
    store: Store;
    blobs: Blobs;
    now: () => string;
    newId: () => string;
    requireOwner: (request: unknown, reply: unknown, projectId: string) => Promise<string | null>;
  },
): void {
  const { store, blobs, now, newId } = deps;

  app.post<{ Params: { id: string } }>("/v1/projects/:id/uploads", async (request, reply) => {
    const ownerId = await deps.requireOwner(request, reply, request.params.id);
    if (!ownerId) return reply;

    const body = CreateUploadBody.safeParse(request.body);
    if (!body.success) return invalid(reply, "Tell us the file's name, size and checksum.");

    const limits = UPLOAD_LIMITS[body.data.kind];
    const ext = extensionOf(body.data.filename);
    if (!(limits.extensions as readonly string[]).includes(ext)) {
      return invalid(
        reply,
        `${ext || "That file type"} isn't one we can read. Try ${limits.extensions.slice(0, 3).join(", ")}.`,
      );
    }
    if (body.data.size > limits.maxBytes) {
      return invalid(
        reply,
        `That file is ${(body.data.size / 1024 / 1024).toFixed(0)} MB — the limit is ${limits.maxBytes / 1024 / 1024} MB.`,
      );
    }
    const existing = await store.listUploads(request.params.id);
    if (existing.filter((u) => u.kind === body.data.kind).length >= limits.maxPerProject) {
      return conflict(reply, `This project already has ${limits.maxPerProject} ${body.data.kind}s.`);
    }

    const id = newId();
    const storageKey = `uploads/${request.params.id}/${id}${ext}`;
    const presigned = await blobs.presignPut(storageKey, "application/octet-stream");
    const upload: Upload = {
      id,
      projectId: request.params.id,
      kind: body.data.kind,
      filename: body.data.filename,
      byteSize: body.data.size,
      sha256: body.data.sha256,
      ...(body.data.wallTag ? { wallTag: body.data.wallTag } : {}),
      status: "pending",
      storageRef: storageKey,
    };
    await store.createUpload(upload);
    return reply.code(201).send({ upload, ...presigned, createdAt: now() });
  });

  app.post<{ Params: { id: string; uploadId: string } }>(
    "/v1/projects/:id/uploads/:uploadId/complete",
    async (request, reply) => {
      const ownerId = await deps.requireOwner(request, reply, request.params.id);
      if (!ownerId) return reply;

      const upload = await store.getUpload(request.params.id, request.params.uploadId);
      if (!upload || !upload.storageRef) return notFound(reply, "That upload");

      const bytes = await blobs.get(upload.storageRef);
      if (!bytes) {
        return problem(reply, {
          type: "https://myroom.app/problems/upload-missing",
          title: "Upload never arrived",
          status: 409,
          detail: "We didn't receive the file. Try uploading it again.",
        });
      }

      const reject = async (detail: string) => {
        await store.updateUpload(upload.id, { status: "rejected" });
        await blobs.deletePrefix(upload.storageRef!);
        return invalid(reply, detail);
      };

      if (bytes.byteLength !== upload.byteSize) {
        return reject("The file that arrived isn't the size we were told to expect. Try again.");
      }
      const digest = createHash("sha256").update(bytes).digest("hex");
      if (digest !== upload.sha256) {
        return reject("The file changed in transit. Try uploading it again.");
      }
      const format = checkUpload(upload.kind, upload.filename, bytes);
      if (!format.ok) return reject(format.reason ?? "We can't read that file.");

      const stored = await store.updateUpload(upload.id, { status: "stored" });
      return reply.send({ upload: stored, format: format.format });
    },
  );

  app.get<{ Params: { id: string } }>("/v1/projects/:id/uploads", async (request, reply) => {
    const ownerId = await deps.requireOwner(request, reply, request.params.id);
    if (!ownerId) return reply;
    return reply.send(await store.listUploads(request.params.id));
  });

  /**
   * Dev/CI storage endpoint. In the hosted build the presigned URL points at
   * S3 and this route does not participate — see `createMemoryBlobs`.
   */
  /**
   * The blob routes live in their own encapsulated scope so that *every*
   * content type is read as raw bytes here, and only here.
   *
   * The catch-all parser in app.ts is registered as `"*"`, which Fastify
   * consults only for content types its built-in parsers decline. It therefore
   * never covered `application/json` or `text/plain`: a JSON-typed upload body
   * arrived already parsed into an object, and `String(body)` stored the
   * fifteen bytes "[object Object]" in place of the file. A text/plain body
   * went through a latin1 round-trip that mangled every multi-byte character.
   *
   * Browsers set `File.type` to "application/json" for a .json file, and the
   * client sends that as the upload's content type — so this destroyed RoomPlan
   * JSON, which docs/05 §2 calls "the gold input". The upload then failed its
   * own size check on /complete, with no way for the user to recover.
   *
   * Removing the parsers inside a child scope leaves the JSON API's own parsing
   * untouched, because Fastify's content-type parsers are encapsulated.
   */
  app.register(async (scope) => {
    scope.removeAllContentTypeParsers();
    scope.addContentTypeParser("*", { parseAs: "buffer" }, (_req, body, done) => done(null, body));

    scope.put<{ Params: { key: string }; Querystring: { expires?: string; sig?: string } }>(
      "/v1/blobs/:key",
      { bodyLimit: UPLOAD_LIMITS.lidar.maxBytes },
      async (request, reply) => {
        const key = decodeURIComponent(request.params.key);
        if (!blobs.verify(key, Number(request.query.expires), request.query.sig ?? "")) {
          return problem(reply, {
            type: "https://myroom.app/problems/expired-url",
            title: "Upload link expired",
            status: 403,
            detail: "That upload link has expired. Ask for a new one and try again.",
          });
        }
        const body = request.body;
        // Every type reaches here as a Buffer now; the fallback stays as a
        // guard rather than a code path anything is expected to take.
        const bytes =
          body instanceof Buffer ? new Uint8Array(body) : new Uint8Array(Buffer.from(String(body ?? ""), "utf8"));
        await blobs.put(key, bytes);
        return reply.code(204).send();
      },
    );
  });

  app.get<{ Params: { key: string }; Querystring: { expires?: string; sig?: string } }>(
    "/v1/blobs/:key",
    async (request, reply) => {
      const key = decodeURIComponent(request.params.key);
      if (!blobs.verify(key, Number(request.query.expires), request.query.sig ?? "")) {
        return problem(reply, {
          type: "https://myroom.app/problems/expired-url",
          title: "Link expired",
          status: 403,
          detail: "That link has expired.",
        });
      }
      const bytes = await blobs.get(key);
      if (!bytes) return notFound(reply, "That file");
      return reply.type("application/octet-stream").send(Buffer.from(bytes));
    },
  );
}
