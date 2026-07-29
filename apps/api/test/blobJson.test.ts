import { describe, expect, it } from "vitest";

import { createHash } from "node:crypto";

import { buildApp } from "../src/app.js";

/**
 * A presigned blob PUT must store the bytes it was given, whatever the
 * content type says they are.
 *
 * The catch-all parser registered in app.ts uses "*", which Fastify consults
 * only for types its built-in parsers refuse. `application/json` is not one of
 * those, so a JSON-typed upload body arrived at the route already parsed into
 * an object, and `String(body)` turned it into the 15 bytes "[object Object]".
 *
 * This is not a corner case: browsers set File.type to "application/json" for a
 * .json file, and apps/web/src/lib/reconstruct.ts sends `upload.blob.type` as
 * the content type. RoomPlan JSON — which docs/05 §2 calls "the gold input" —
 * was destroyed on the way in.
 */

const ROOMPLAN = JSON.stringify({
  walls: [{ transform: Array(16).fill(0), dimensions: [4, 2.44, 0.1] }],
  objects: [],
});

async function signIn(app: Awaited<ReturnType<typeof buildApp>>) {
  const link = await app.inject({
    method: "POST",
    url: "/v1/auth/magic-link",
    payload: { email: "blob@test.local" },
  });
  const token = link.json().token as string;
  const session = await app.inject({ method: "POST", url: "/v1/auth/session", payload: { token } });
  return session.cookies.map((c) => `${c.name}=${c.value}`).join("; ");
}

describe("presigned blob PUT preserves the bytes", () => {
  it.each([
    ["application/json", ROOMPLAN],
    ["text/plain", "héllo wörld — multi-byte"],
    ["application/octet-stream", "opaque bytes"],
  ])("round-trips a %s body unchanged", async (contentType, payload) => {
    const app = await buildApp();
    const cookie = await signIn(app);

    const project = await app.inject({
      method: "POST",
      url: "/v1/projects",
      headers: { cookie },
      payload: { name: "Blob test" },
    });
    const projectId = project.json().id as string;

    const presign = await app.inject({
      method: "POST",
      url: `/v1/projects/${projectId}/uploads`,
      headers: { cookie },
      payload: {
        kind: "lidar",
        filename: "room.json",
        size: Buffer.byteLength(payload),
        sha256: createHash("sha256").update(Buffer.from(payload)).digest("hex"),
      },
    });
    expect(presign.statusCode, presign.body).toBe(201);
    const { uploadUrl } = presign.json() as { uploadUrl: string };

    const put = await app.inject({
      method: "PUT",
      url: uploadUrl,
      headers: { "content-type": contentType },
      payload,
    });
    expect(put.statusCode, put.body).toBe(204);

    const stored = await app.inject({ method: "GET", url: uploadUrl });
    expect(stored.statusCode).toBe(200);
    expect(stored.rawPayload.length).toBe(Buffer.byteLength(payload));
    expect(stored.rawPayload.toString("utf8")).toBe(payload);

    await app.close();
  });
});
