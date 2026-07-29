import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { buildApp } from "../src/app.js";

/**
 * The magic-link token is a bearer credential: whoever holds it becomes the
 * address it was issued for. Returning it in the HTTP response is a debugging
 * convenience, and it used to be enabled by `NODE_ENV !== "production"`.
 *
 * Nothing in this repository sets NODE_ENV. There is no Dockerfile and the
 * start script is a bare `tsx src/server.ts`, so a deployed API ran with it
 * undefined — and an unauthenticated POST with a stranger's email address
 * returned that stranger's sign-in token.
 *
 * These tests pin the inverted default: no configuration means no token.
 */

const saved = { dev: process.env.MYROOM_DEV_AUTH, node: process.env.NODE_ENV, secret: process.env.SESSION_SECRET };

beforeEach(() => {
  delete process.env.MYROOM_DEV_AUTH;
  delete process.env.NODE_ENV;
  process.env.SESSION_SECRET = "test-secret-for-the-auth-gate-000000000000";
});

afterEach(() => {
  if (saved.dev === undefined) delete process.env.MYROOM_DEV_AUTH;
  else process.env.MYROOM_DEV_AUTH = saved.dev;
  if (saved.node === undefined) delete process.env.NODE_ENV;
  else process.env.NODE_ENV = saved.node;
  if (saved.secret === undefined) delete process.env.SESSION_SECRET;
  else process.env.SESSION_SECRET = saved.secret;
});

describe("an unconfigured API does not hand out sign-in tokens", () => {
  it("withholds the token when NODE_ENV is undefined", async () => {
    const app = await buildApp();
    const response = await app.inject({
      method: "POST",
      url: "/v1/auth/magic-link",
      payload: { email: "victim@example.com" },
    });
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.sent).toBe(true);
    expect(body.token).toBeUndefined();
    // Nothing else in the payload may be redeemable either.
    expect(JSON.stringify(body)).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-/i);
    await app.close();
  });

  it("still returns it when someone deliberately asks for dev auth", async () => {
    process.env.MYROOM_DEV_AUTH = "1";
    const app = await buildApp();
    const response = await app.inject({
      method: "POST",
      url: "/v1/auth/magic-link",
      payload: { email: "dev@example.com" },
    });
    expect(response.json().token).toBeTypeOf("string");
    await app.close();
  });

  it("marks the session cookie Secure when dev auth is off", async () => {
    // The flag is read when the cookie is issued, so one app can mint the
    // token with dev auth on and redeem it with dev auth off.
    process.env.MYROOM_DEV_AUTH = "1";
    const app = await buildApp();
    const link = await app.inject({
      method: "POST",
      url: "/v1/auth/magic-link",
      payload: { email: "e@f.test" },
    });
    const token = link.json().token as string;

    delete process.env.MYROOM_DEV_AUTH;
    const session = await app.inject({ method: "POST", url: "/v1/auth/session", payload: { token } });
    expect(session.statusCode).toBe(200);

    const cookie = session.cookies.find((c) => c.name === "myroom_session");
    expect(cookie).toBeDefined();
    expect(cookie!.secure).toBe(true);
    expect(cookie!.httpOnly).toBe(true);
    await app.close();
  });

  it("refuses to start without a signing secret when dev auth is off", async () => {
    delete process.env.SESSION_SECRET;
    const { devAuthEnabled } = await import("../src/auth.js");
    expect(devAuthEnabled()).toBe(false);

    const app = await buildApp();
    process.env.MYROOM_DEV_AUTH = "1";
    const link = await app.inject({
      method: "POST",
      url: "/v1/auth/magic-link",
      payload: { email: "g@h.test" },
    });
    const token = link.json().token as string;
    delete process.env.MYROOM_DEV_AUTH;

    // Signing now has no secret and no permitted fallback: it must throw
    // rather than mint a session anyone could forge.
    const session = await app.inject({
      method: "POST",
      url: "/v1/auth/session",
      payload: { token },
    });
    expect(session.statusCode).toBeGreaterThanOrEqual(500);
    await app.close();
  });
});
