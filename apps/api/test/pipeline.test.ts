import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { FastifyInstance } from "fastify";
import { SceneSchema, JobEventSchema, type JobEvent } from "@myroom/schema";
import { buildApp } from "../src/app.js";

const planFixture = () =>
  JSON.parse(
    readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), "../../../packages/schema/test/fixtures/plan-rectangle.json"),
      "utf8",
    ),
  );

/** A minimal but real JPEG header, so magic-byte validation sees the truth. */
const jpegBytes = (payload = "photo") => Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.from(payload)]);

let app: FastifyInstance;
let cookie: string;
let projectId: string;
const inflight: Promise<unknown>[] = [];

async function settle() {
  await Promise.all(inflight.splice(0));
}

async function uploadPhoto(bytes: Buffer, filename = "wall-a.jpg", wallTag = "A") {
  const created = await app.inject({
    method: "POST",
    url: `/v1/projects/${projectId}/uploads`,
    headers: { cookie },
    payload: {
      kind: "photo",
      filename,
      size: bytes.byteLength,
      sha256: createHash("sha256").update(bytes).digest("hex"),
      wallTag,
    },
  });
  const body = created.json();
  const put = await app.inject({
    method: "PUT",
    url: body.uploadUrl,
    headers: { "content-type": "application/octet-stream" },
    payload: bytes,
  });
  const complete = await app.inject({
    method: "POST",
    url: `/v1/projects/${projectId}/uploads/${body.upload.id}/complete`,
    headers: { cookie },
  });
  return { created, put, complete, uploadId: body.upload.id as string };
}

beforeEach(async () => {
  app = await buildApp({ track: (w) => inflight.push(w) });
  const link = await app.inject({ method: "POST", url: "/v1/auth/magic-link", payload: { email: "a@b.test" } });
  const session = await app.inject({ method: "POST", url: "/v1/auth/session", payload: { token: link.json().token } });
  cookie = session.headers["set-cookie"]!.toString().split(";")[0]!;
  const project = await app.inject({
    method: "POST",
    url: "/v1/projects",
    headers: { cookie },
    payload: { name: "Living room" },
  });
  projectId = project.json().id;
  await app.inject({ method: "PUT", url: `/v1/projects/${projectId}/plan`, headers: { cookie }, payload: planFixture() });
});

afterEach(async () => {
  await settle();
  await app.close();
});

describe("uploads (docs/03 §3)", () => {
  it("presigns, accepts the bytes, and confirms the file", async () => {
    const { created, put, complete } = await uploadPhoto(jpegBytes());
    expect(created.statusCode).toBe(201);
    expect(created.json().uploadUrl).toContain("/v1/blobs/");
    expect(put.statusCode).toBe(204);
    expect(complete.statusCode).toBe(200);
    expect(complete.json().upload.status).toBe("stored");
    expect(complete.json().format).toBe("jpeg");
  });

  it("rejects a file whose bytes disagree with its name", async () => {
    // A PNG renamed .jpg: the extension is a claim, the magic bytes are proof.
    const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from("x")]);
    const { complete } = await uploadPhoto(png, "sneaky.jpg");
    expect(complete.statusCode).toBe(422);
    expect(complete.json().detail).toContain("png");
  });

  it("rejects bytes that don't match the declared checksum", async () => {
    const bytes = jpegBytes();
    const created = await app.inject({
      method: "POST",
      url: `/v1/projects/${projectId}/uploads`,
      headers: { cookie },
      payload: { kind: "photo", filename: "a.jpg", size: bytes.byteLength, sha256: "0".repeat(64) },
    });
    await app.inject({
      method: "PUT",
      url: created.json().uploadUrl,
      headers: { "content-type": "application/octet-stream" },
      payload: bytes,
    });
    const complete = await app.inject({
      method: "POST",
      url: `/v1/projects/${projectId}/uploads/${created.json().upload.id}/complete`,
      headers: { cookie },
    });
    expect(complete.statusCode).toBe(422);
  });

  it("refuses a file type it can't read, before any bytes move", async () => {
    const res = await app.inject({
      method: "POST",
      url: `/v1/projects/${projectId}/uploads`,
      headers: { cookie },
      payload: { kind: "photo", filename: "notes.pdf", size: 100, sha256: "a".repeat(64) },
    });
    expect(res.statusCode).toBe(422);
    expect(res.json().detail).toContain(".pdf");
  });

  it("refuses an expired or unsigned upload URL", async () => {
    const res = await app.inject({
      method: "PUT",
      url: `/v1/blobs/uploads%2Fx%2Fy.jpg?expires=9999999999&sig=deadbeef`,
      payload: jpegBytes(),
    });
    expect(res.statusCode).toBe(403);
  });
});

describe("reconstruction (docs/03 §4, docs/05 §8)", () => {
  it("builds a scene from the plan and reports every stage", async () => {
    await uploadPhoto(jpegBytes("a"), "wall-a.jpg", "A");
    await uploadPhoto(jpegBytes("b"), "wall-b.jpg", "B");
    const uploads = (await app.inject({ method: "GET", url: `/v1/projects/${projectId}/uploads`, headers: { cookie } })).json();

    const started = await app.inject({
      method: "POST",
      url: `/v1/projects/${projectId}/reconstruct`,
      headers: { cookie },
      payload: { photoIds: uploads.map((u: { id: string }) => u.id) },
    });
    expect(started.statusCode).toBe(202);
    await settle();

    const job = (await app.inject({ method: "GET", url: `/v1/jobs/${started.json().jobId}`, headers: { cookie } })).json();
    expect(job.stage).toBe("done");
    expect(["succeeded", "partial"]).toContain(job.status);
    expect(job.tier).toBe("photo");

    const scene = await app.inject({ method: "GET", url: `/v1/projects/${projectId}/scene`, headers: { cookie } });
    expect(scene.statusCode).toBe(200);
    const parsed = SceneSchema.parse(scene.json());
    expect(parsed.objects.length).toBeGreaterThan(0);
    // Every object the pipeline placed carries its provenance (docs/07 §3).
    expect(parsed.objects.every((o) => o.recon !== null)).toBe(true);
    expect(parsed.provenance.reconstructionJobId).toBe(started.json().jobId);
  });

  it("never dead-ends: with no usable photos it still returns the accurate room", async () => {
    const started = await app.inject({
      method: "POST",
      url: `/v1/projects/${projectId}/reconstruct`,
      headers: { cookie },
      payload: { photoIds: [] },
    });
    await settle();
    const job = (await app.inject({ method: "GET", url: `/v1/jobs/${started.json().jobId}`, headers: { cookie } })).json();
    expect(job.status).toBe("partial");
    expect(job.tier).toBe("sketch");
    const scene = await app.inject({ method: "GET", url: `/v1/projects/${projectId}/scene`, headers: { cookie } });
    // A room, correctly shaped, with a friendly nudge — not an error screen.
    expect(scene.statusCode).toBe(200);
    expect(job.warnings.join(" ")).toContain("add pieces yourself");
  });

  it("refuses to reconstruct a project with no closed plan", async () => {
    const fresh = await app.inject({ method: "POST", url: "/v1/projects", headers: { cookie }, payload: { name: "Empty" } });
    const res = await app.inject({
      method: "POST",
      url: `/v1/projects/${fresh.json().id}/reconstruct`,
      headers: { cookie },
      payload: { photoIds: [] },
    });
    expect(res.statusCode).toBe(422);
  });

  it("rate-limits to 10 reconstructions per project per day", async () => {
    for (let i = 0; i < 10; i++) {
      const res = await app.inject({
        method: "POST",
        url: `/v1/projects/${projectId}/reconstruct`,
        headers: { cookie },
        payload: { photoIds: [] },
      });
      expect(res.statusCode).toBe(202);
      await settle();
    }
    const eleventh = await app.inject({
      method: "POST",
      url: `/v1/projects/${projectId}/reconstruct`,
      headers: { cookie },
      payload: { photoIds: [] },
    });
    expect(eleventh.statusCode).toBe(429);
  });

  it("streams progress over SSE and replays what a reconnect missed", async () => {
    const address = await app.listen({ port: 0, host: "127.0.0.1" });
    const started = await app.inject({
      method: "POST",
      url: `/v1/projects/${projectId}/reconstruct`,
      headers: { cookie },
      payload: { photoIds: [] },
    });
    await settle();

    // Connect *after* the job finished: Last-Event-ID 0 must replay everything,
    // which is exactly what a phone returning from the background does.
    const res = await fetch(`${address}/v1/jobs/${started.json().jobId}/events`, {
      headers: { cookie, "last-event-id": "0" },
    });
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    const text = await res.text();
    const events: JobEvent[] = text
      .split("\n\n")
      .map((chunk) => chunk.split("\n").find((l) => l.startsWith("data: ")))
      .filter((l): l is string => Boolean(l))
      .map((l) => JobEventSchema.parse(JSON.parse(l.slice(6))));

    expect(events.some((e) => e.type === "stage" && e.stage === "scene-assemble")).toBe(true);
    expect(events.at(-1)?.type).toBe("done");
  });
});

describe("scene, versions and sharing", () => {
  async function reconstruct() {
    const started = await app.inject({
      method: "POST",
      url: `/v1/projects/${projectId}/reconstruct`,
      headers: { cookie },
      payload: { photoIds: [] },
    });
    await settle();
    return started.json().jobId as string;
  }

  it("refuses a stale scene write instead of overwriting a newer one", async () => {
    await reconstruct();
    const fetched = await app.inject({ method: "GET", url: `/v1/projects/${projectId}/scene`, headers: { cookie } });
    const etag = fetched.headers.etag as string;
    const scene = fetched.json();

    const first = await app.inject({
      method: "PUT",
      url: `/v1/projects/${projectId}/scene`,
      headers: { cookie, "if-match": etag },
      payload: scene,
    });
    expect(first.statusCode).toBe(200);

    const stale = await app.inject({
      method: "PUT",
      url: `/v1/projects/${projectId}/scene`,
      headers: { cookie, "if-match": etag },
      payload: scene,
    });
    expect(stale.statusCode).toBe(409);
  });

  it("locks version zero and mints read-only share links", async () => {
    await reconstruct();
    const zero = await app.inject({
      method: "POST",
      url: `/v1/projects/${projectId}/versions`,
      headers: { cookie },
      payload: { name: "Original room" },
    });
    expect(zero.json().locked).toBe(true);
    const deleted = await app.inject({
      method: "DELETE",
      url: `/v1/projects/${projectId}/versions/${zero.json().id}`,
      headers: { cookie },
    });
    expect(deleted.statusCode).toBe(404);

    const share = await app.inject({ method: "POST", url: `/v1/projects/${projectId}/share`, headers: { cookie } });
    expect(share.statusCode).toBe(201);
    // No cookie: a share link is the whole credential, and it is read-only.
    const resolved = await app.inject({ method: "GET", url: `/v1/shared/${share.json().token}` });
    expect(resolved.statusCode).toBe(200);
    expect(resolved.json().scene.objects).toBeDefined();
    expect(resolved.json().plan.closed).toBe(true);
  });

  it("serves the catalog filtered by category and by what fits", async () => {
    const all = await app.inject({ method: "GET", url: "/v1/catalog" });
    expect(all.statusCode).toBe(200);
    const items = all.json();
    if (items.length > 0) {
      const category = items[0].category;
      const filtered = await app.inject({ method: "GET", url: `/v1/catalog?category=${category}` });
      expect(filtered.json().every((i: { category: string }) => i.category === category)).toBe(true);
      const tiny = await app.inject({ method: "GET", url: "/v1/catalog?fits=0.05x0.05x0.05" });
      expect(tiny.json()).toHaveLength(0);
    }
  });
});
