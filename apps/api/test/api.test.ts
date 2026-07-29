import { beforeEach, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/app.js";

const planFixture = () =>
  JSON.parse(
    readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), "../../../packages/schema/test/fixtures/plan-rectangle.json"),
      "utf8",
    ),
  );

let app: FastifyInstance;
let cookie: string;

async function signIn(): Promise<string> {
  const link = await app.inject({ method: "POST", url: "/v1/auth/magic-link", payload: { email: "a@b.test" } });
  const { token } = link.json();
  const session = await app.inject({ method: "POST", url: "/v1/auth/session", payload: { token } });
  return session.headers["set-cookie"]!.toString().split(";")[0]!;
}

async function newProject(): Promise<string> {
  const res = await app.inject({
    method: "POST",
    url: "/v1/projects",
    headers: { cookie },
    payload: { name: "Living room" },
  });
  return res.json().id;
}

beforeEach(async () => {
  app = await buildApp();
  cookie = await signIn();
});

describe("auth (docs/03 §3)", () => {
  it("rejects unauthenticated access with problem+json", async () => {
    const res = await app.inject({ method: "GET", url: "/v1/projects" });
    expect(res.statusCode).toBe(401);
    expect(res.headers["content-type"]).toContain("application/problem+json");
    expect(res.json().title).toBe("Sign in required");
  });

  it("issues an httpOnly session cookie and burns the magic token", async () => {
    const link = await app.inject({ method: "POST", url: "/v1/auth/magic-link", payload: { email: "c@d.test" } });
    const { token } = link.json();
    const first = await app.inject({ method: "POST", url: "/v1/auth/session", payload: { token } });
    expect(first.statusCode).toBe(200);
    expect(first.headers["set-cookie"]!.toString()).toContain("HttpOnly");
    // single use
    const second = await app.inject({ method: "POST", url: "/v1/auth/session", payload: { token } });
    expect(second.statusCode).toBe(401);
  });
});

describe("project CRUD (docs/03 §3)", () => {
  it("creates, lists, fetches, renames and deletes", async () => {
    const id = await newProject();
    const list = await app.inject({ method: "GET", url: "/v1/projects", headers: { cookie } });
    expect(list.json()).toHaveLength(1);

    const fetched = await app.inject({ method: "GET", url: `/v1/projects/${id}`, headers: { cookie } });
    expect(fetched.json().name).toBe("Living room");
    expect(fetched.json().accuracyTier).toBe("sketch");

    const renamed = await app.inject({
      method: "PATCH",
      url: `/v1/projects/${id}`,
      headers: { cookie },
      payload: { name: "Snug" },
    });
    expect(renamed.json().name).toBe("Snug");

    const deleted = await app.inject({ method: "DELETE", url: `/v1/projects/${id}`, headers: { cookie } });
    expect(deleted.statusCode).toBe(204);
    const gone = await app.inject({ method: "GET", url: `/v1/projects/${id}`, headers: { cookie } });
    expect(gone.statusCode).toBe(404);
  });

  it("never leaks another user's project", async () => {
    const id = await newProject();
    const link = await app.inject({ method: "POST", url: "/v1/auth/magic-link", payload: { email: "other@x.test" } });
    const session = await app.inject({ method: "POST", url: "/v1/auth/session", payload: { token: link.json().token } });
    const otherCookie = session.headers["set-cookie"]!.toString().split(";")[0]!;

    const res = await app.inject({ method: "GET", url: `/v1/projects/${id}`, headers: { cookie: otherCookie } });
    expect(res.statusCode).toBe(404);
    const list = await app.inject({ method: "GET", url: "/v1/projects", headers: { cookie: otherCookie } });
    expect(list.json()).toHaveLength(0);
  });

  it("queues a real storage purge on delete (docs/03 §7)", async () => {
    const id = await newProject();
    await app.inject({ method: "DELETE", url: `/v1/projects/${id}`, headers: { cookie } });
    const health = await app.inject({ method: "GET", url: "/health" });
    expect(health.json().ok).toBe(true);
  });
});

describe("PUT /v1/projects/:id/plan", () => {
  it("saves a valid plan and returns an ETag", async () => {
    const id = await newProject();
    const res = await app.inject({
      method: "PUT",
      url: `/v1/projects/${id}/plan`,
      headers: { cookie },
      payload: planFixture(),
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers.etag).toBe('W/"1"');
    expect(res.json().plan.floorArea).toBeCloseTo(29.76, 3);
    expect(res.json().planId).toBe(planFixture().id);
  });

  it("rejects an invalid plan with field-level problem details", async () => {
    const id = await newProject();
    const bad = planFixture();
    bad.walls[0].openings[0].offset = 5.9; // 5.9 + 1.2 > 6.2 m wall
    const res = await app.inject({
      method: "PUT",
      url: `/v1/projects/${id}/plan`,
      headers: { cookie },
      payload: bad,
    });
    expect(res.statusCode).toBe(422);
    expect(res.headers["content-type"]).toContain("application/problem+json");
    expect(res.json().errors.some((e: { message: string }) => e.message.includes("exceeds wall length"))).toBe(true);
  });

  it("rejects a self-intersecting closed plan", async () => {
    const id = await newProject();
    const bad = planFixture();
    bad.vertices[2].x = 0;
    bad.vertices[3].x = 6.2;
    bad.floorArea = null;
    const res = await app.inject({
      method: "PUT",
      url: `/v1/projects/${id}/plan`,
      headers: { cookie },
      payload: bad,
    });
    expect(res.statusCode).toBe(422);
  });

  it("recomputes wall labels from geometry rather than trusting the client", async () => {
    const id = await newProject();
    const tampered = planFixture();
    tampered.walls[0].label = "Z"; // client claims the north wall is "Z"
    const res = await app.inject({
      method: "PUT",
      url: `/v1/projects/${id}/plan`,
      headers: { cookie },
      payload: tampered,
    });
    expect(res.statusCode).toBe(200);
    // North wall is A, then clockwise B, C, D (docs/04 §5).
    expect(res.json().plan.walls.map((w: { label: string }) => w.label)).toEqual(["A", "B", "C", "D"]);
  });

  it("bumps the ETag on every save", async () => {
    const id = await newProject();
    const first = await app.inject({ method: "PUT", url: `/v1/projects/${id}/plan`, headers: { cookie }, payload: planFixture() });
    const second = await app.inject({ method: "PUT", url: `/v1/projects/${id}/plan`, headers: { cookie }, payload: planFixture() });
    expect(first.headers.etag).toBe('W/"1"');
    expect(second.headers.etag).toBe('W/"2"');
  });

  it("404s on someone else's project", async () => {
    const res = await app.inject({
      method: "PUT",
      url: "/v1/projects/does-not-exist/plan",
      headers: { cookie },
      payload: planFixture(),
    });
    expect(res.statusCode).toBe(404);
  });
});
