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

function secret(): Uint8Array {
  const raw = process.env.SESSION_SECRET;
  if (!raw) {
    if (process.env.NODE_ENV === "production") {
      throw new Error("SESSION_SECRET must be set in production");
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
    secure: process.env.NODE_ENV === "production",
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
