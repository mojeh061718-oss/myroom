import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";
import { buildApp } from "../src/app.js";

const out: string[] = [];
const log = (...a: unknown[]) => out.push(a.map((x) => (typeof x === "string" ? x : JSON.stringify(x))).join(" "));

async function signIn(app: any) {
  const link = await app.inject({ method: "POST", url: "/v1/auth/magic-link", payload: { email: "a@b.test" } });
  const s = await app.inject({ method: "POST", url: "/v1/auth/session", payload: { token: link.json().token } });
  return s.headers["set-cookie"]!.toString().split(";")[0]!;
}

describe("probe", () => {
  it("json lidar upload with application/json content-type", async () => {
    const app = await buildApp({ track: () => {} });
    const cookie = await signIn(app);
    const p = await app.inject({ method: "POST", url: "/v1/projects", headers: { cookie }, payload: { name: "x" } });
    const projectId = p.json().id;
    const scanJson = Buffer.from(JSON.stringify({ walls: [{ start: [0, 0], end: [1, 0] }], objects: [] }));
    const created = await app.inject({
      method: "POST",
      url: `/v1/projects/${projectId}/uploads`,
      headers: { cookie },
      payload: { kind: "lidar", filename: "room.json", size: scanJson.byteLength, sha256: createHash("sha256").update(scanJson).digest("hex") },
    });
    log("CREATE", created.statusCode, created.json().uploadUrl);
    const put = await app.inject({
      method: "PUT",
      url: created.json().uploadUrl,
      headers: { "content-type": "application/json" },
      payload: scanJson,
    });
    log("PUT", put.statusCode, put.body);
    const get = await app.inject({ method: "GET", url: created.json().uploadUrl.replace("/v1/blobs", "/v1/blobs") });
    log("GETBACK", get.statusCode, JSON.stringify(get.rawPayload.toString("utf8")));
    const complete = await app.inject({
      method: "POST",
      url: `/v1/projects/${projectId}/uploads/${created.json().upload.id}/complete`,
      headers: { cookie },
    });
    log("COMPLETE", complete.statusCode, complete.body);

    // --- part 2: re-PUT after complete (TOCTOU) with octet-stream
    const jpeg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.from("real photo")]);
    const c2 = await app.inject({
      method: "POST",
      url: `/v1/projects/${projectId}/uploads`,
      headers: { cookie },
      payload: { kind: "photo", filename: "a.jpg", size: jpeg.byteLength, sha256: createHash("sha256").update(jpeg).digest("hex") },
    });
    await app.inject({ method: "PUT", url: c2.json().uploadUrl, headers: { "content-type": "application/octet-stream" }, payload: jpeg });
    const done2 = await app.inject({ method: "POST", url: `/v1/projects/${projectId}/uploads/${c2.json().upload.id}/complete`, headers: { cookie } });
    log("COMPLETE2", done2.statusCode, done2.body);
    const evil = Buffer.from("#!/bin/sh\nrm -rf /\n".repeat(4));
    const reput = await app.inject({ method: "PUT", url: c2.json().uploadUrl, headers: { "content-type": "application/octet-stream" }, payload: evil });
    log("REPUT", reput.statusCode);
    const back = await app.inject({ method: "GET", url: c2.json().uploadUrl });
    log("READBACK", back.statusCode, JSON.stringify(back.rawPayload.toString("utf8")));
    const list = await app.inject({ method: "GET", url: `/v1/projects/${projectId}/uploads`, headers: { cookie } });
    log("UPLOADS", JSON.stringify(list.json()));

    // --- part 3: oversize PUT to a photo key
    const huge = Buffer.alloc(30 * 1024 * 1024, 7);
    const c3 = await app.inject({
      method: "POST",
      url: `/v1/projects/${projectId}/uploads`,
      headers: { cookie },
      payload: { kind: "photo", filename: "b.jpg", size: 4, sha256: createHash("sha256").update(Buffer.alloc(4)).digest("hex") },
    });
    const bigput = await app.inject({ method: "PUT", url: c3.json().uploadUrl, headers: { "content-type": "application/octet-stream" }, payload: huge });
    log("BIGPUT(30MB to a 4-byte photo)", bigput.statusCode);

    writeFileSync("/tmp/claude-0/-home-user-myroom/180aecc3-2534-516b-8801-2a0723b4198c/scratchpad/probe.txt", out.join("\n"));
    await app.close();
  });
});
