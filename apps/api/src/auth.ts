import { SignJWT, jwtVerify } from "jose";
import type { FastifyReply, FastifyRequest } from "fastify";

/**
 * Session tokens (docs/03 §3): JWT in an httpOnly cookie.
 *
 * M1 ships email magic-link issuance; passkeys (@simplewebauthn/server, docs/08
 * §2) become the primary factor alongside it before the hosted launch. Both
 * mint the same session cookie, so route code never changes.
 */

const COOKIE = "myroom_session";
const ALG = "HS256";

export interface Session {
  userId: string;
}

/**
 * Whether the development-only auth conveniences are switched on.
 *
 * These three behaviours are safe on a laptop and catastrophic anywhere else:
 * returning the sign-in token in the magic-link response, falling back to a
 * hardcoded signing secret, and dropping the `Secure` flag from the session
 * cookie.
 *
 * They used to be gated on `NODE_ENV !== "production"`, which failed open.
 * Nothing in this repository sets NODE_ENV — there is no Dockerfile, and the
 * start script is a bare `tsx src/server.ts` — so a deployed API ran with
 * NODE_ENV undefined and every one of those three behaviours active. An
 * unauthenticated POST to /v1/auth/magic-link with any address returned that
 * address's sign-in token, which redeemed for a valid session: full read/write
 * access to a stranger's projects, photos and scenes.
 *
 * So the default is inverted. Absence of configuration now means production
 * behaviour, and the conveniences require someone to have deliberately asked
 * for them. NODE_ENV === "test" is honoured so the suite needs no ceremony;
 * a deployment never sets that.
 */
export function devAuthEnabled(): boolean {
  return process.env.MYROOM_DEV_AUTH === "1" || process.env.NODE_ENV === "test";
}

function secret(): Uint8Array {
  const raw = process.env.SESSION_SECRET;
  if (!raw) {
    if (!devAuthEnabled()) {
      throw new Error(
        "SESSION_SECRET must be set. To run locally without one, set MYROOM_DEV_AUTH=1 — " +
          "it also returns sign-in tokens in API responses, so never set it on a deployed API.",
      );
    }
    return new TextEncoder().encode("dev-only-insecure-secret-do-not-ship-000000");
  }
  return new TextEncoder().encode(raw);
}

export async function issueSession(reply: FastifyReply, userId: string): Promise<string> {
  const token = await new SignJWT({ sub: userId })
    .setProtectedHeader({ alg: ALG })
    .setIssuedAt()
    .setExpirationTime("30d")
    .sign(secret());
  reply.setCookie(COOKIE, token, {
    httpOnly: true,
    sameSite: "lax",
    // Secure by default; only a deliberate dev opt-in drops it.
    secure: !devAuthEnabled(),
    path: "/",
    maxAge: 60 * 60 * 24 * 30,
  });
  return token;
}

export function clearSession(reply: FastifyReply): void {
  reply.clearCookie(COOKIE, { path: "/" });
}

export async function readSession(request: FastifyRequest): Promise<Session | null> {
  const raw = request.cookies?.[COOKIE];
  if (!raw) return null;
  try {
    const { payload } = await jwtVerify(raw, secret(), { algorithms: [ALG] });
    return typeof payload.sub === "string" ? { userId: payload.sub } : null;
  } catch {
    return null;
  }
}
