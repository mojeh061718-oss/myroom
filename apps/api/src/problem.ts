import type { FastifyReply } from "fastify";

/**
 * RFC 9457 problem+json errors (docs/03 §3). The client turns `detail` into
 * plain-language guidance (docs/01 §7), so keep it human-readable.
 */
export interface Problem {
  type: string;
  title: string;
  status: number;
  detail?: string;
  /** field-level validation issues, when the failure came from packages/schema */
  errors?: { path: string; message: string }[];
}

export function problem(reply: FastifyReply, p: Problem): FastifyReply {
  return reply.code(p.status).type("application/problem+json").send(p);
}

export const notFound = (reply: FastifyReply, what: string) =>
  problem(reply, {
    type: "https://myroom.app/problems/not-found",
    title: "Not found",
    status: 404,
    detail: `${what} does not exist, or you don't have access to it.`,
  });

export const unauthorized = (reply: FastifyReply) =>
  problem(reply, {
    type: "https://myroom.app/problems/unauthorized",
    title: "Sign in required",
    status: 401,
    detail: "This request needs a signed-in session.",
  });

export const invalid = (reply: FastifyReply, detail: string, errors?: Problem["errors"]) =>
  problem(reply, {
    type: "https://myroom.app/problems/invalid-request",
    title: "Invalid request",
    status: 422,
    detail,
    ...(errors ? { errors } : {}),
  });

export const conflict = (reply: FastifyReply, detail: string) =>
  problem(reply, {
    type: "https://myroom.app/problems/conflict",
    title: "Conflict",
    status: 409,
    detail,
  });
