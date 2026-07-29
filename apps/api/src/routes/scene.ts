import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { randomBytes } from "node:crypto";
import { SceneSchema } from "@myroom/schema";
import { z } from "zod";
import { CATALOG_ITEMS } from "@myroom/catalog";
import type { Store } from "../store.js";
import { conflict, invalid, notFound } from "../problem.js";

/**
 * Scene, version, share and catalog routes (docs/03 §3).
 *
 * Scene writes use ETag optimistic concurrency: the client sends the version it
 * edited, and a stale write is refused rather than silently overwriting a newer
 * scene (docs/03 §6 keeps the losing copy as a recovery version client-side).
 */
export function registerSceneRoutes(
  app: FastifyInstance,
  deps: {
    store: Store;
    now: () => string;
    newId: () => string;
    requireOwner: (request: FastifyRequest, reply: FastifyReply, projectId: string) => Promise<string | null>;
  },
): void {
  const { store, now, newId } = deps;

  app.get<{ Params: { id: string } }>("/v1/projects/:id/scene", async (request, reply) => {
    const ownerId = await deps.requireOwner(request, reply, request.params.id);
    if (!ownerId) return reply;
    const project = await store.getProject(ownerId, request.params.id);
    if (!project?.scene) return notFound(reply, "A scene for that project");
    return reply.header("etag", `W/"${project.sceneVersion}"`).send(project.scene);
  });

  app.put<{ Params: { id: string } }>("/v1/projects/:id/scene", async (request, reply) => {
    const ownerId = await deps.requireOwner(request, reply, request.params.id);
    if (!ownerId) return reply;

    const parsed = SceneSchema.safeParse(request.body);
    if (!parsed.success) {
      return invalid(
        reply,
        "That room couldn't be saved — some of its objects are missing required details.",
        parsed.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })),
      );
    }

    const project = await store.getProject(ownerId, request.params.id);
    if (!project) return notFound(reply, "That project");

    const ifMatch = request.headers["if-match"];
    if (ifMatch && ifMatch !== `W/"${project.sceneVersion}"`) {
      return conflict(
        reply,
        "This room changed on another device. We kept both — open the version list to compare them.",
      );
    }

    const saved = await store.saveScene(ownerId, request.params.id, parsed.data, now());
    return reply.header("etag", `W/"${saved!.sceneVersion}"`).send({ sceneVersion: saved!.sceneVersion });
  });

  // --- versions --------------------------------------------------------------
  app.post<{ Params: { id: string } }>("/v1/projects/:id/versions", async (request, reply) => {
    const ownerId = await deps.requireOwner(request, reply, request.params.id);
    if (!ownerId) return reply;
    const body = z.object({ name: z.string().min(1).max(120) }).safeParse(request.body);
    if (!body.success) return invalid(reply, "Give this version a name.");
    const project = await store.getProject(ownerId, request.params.id);
    if (!project?.scene) return notFound(reply, "A scene for that project");

    const existing = await store.listVersions(request.params.id);
    const version = await store.createVersion({
      id: newId(),
      projectId: request.params.id,
      name: body.data.name,
      scene: structuredClone(project.scene),
      createdAt: now(),
      // Version zero, "Original room", can never be overwritten (docs/01 §11).
      locked: existing.length === 0,
    });
    return reply.code(201).send({ ...version, scene: undefined });
  });

  app.get<{ Params: { id: string } }>("/v1/projects/:id/versions", async (request, reply) => {
    const ownerId = await deps.requireOwner(request, reply, request.params.id);
    if (!ownerId) return reply;
    const versions = await store.listVersions(request.params.id);
    return reply.send(versions);
  });

  app.delete<{ Params: { id: string; versionId: string } }>(
    "/v1/projects/:id/versions/:versionId",
    async (request, reply) => {
      const ownerId = await deps.requireOwner(request, reply, request.params.id);
      if (!ownerId) return reply;
      const deleted = await store.deleteVersion(request.params.id, request.params.versionId);
      if (!deleted) return notFound(reply, "That version, or it's the locked original");
      return reply.code(204).send();
    },
  );

  // --- share (docs/03 §3, docs/06 §6) ---------------------------------------
  app.post<{ Params: { id: string } }>("/v1/projects/:id/share", async (request, reply) => {
    const ownerId = await deps.requireOwner(request, reply, request.params.id);
    if (!ownerId) return reply;
    const project = await store.getProject(ownerId, request.params.id);
    if (!project?.scene) return notFound(reply, "A scene for that project");
    const token = randomBytes(24).toString("base64url");
    await store.createShare({
      token,
      projectId: request.params.id,
      createdAt: now(),
      expiresAt: null,
    });
    return reply.code(201).send({ token, url: `/shared/${token}` });
  });

  /** Read-only, unauthenticated: the whole point of a share link. */
  app.get<{ Params: { token: string } }>("/v1/shared/:token", async (request, reply) => {
    const share = await store.getShare(request.params.token);
    if (!share) return notFound(reply, "That shared room");
    if (share.expiresAt && share.expiresAt < now()) return notFound(reply, "That shared room");
    // Deliberately does not go through requireOwner: a share token authorizes
    // exactly one project, read-only, and carries no session.
    const record = await store.getProjectById(share.projectId);
    if (!record?.scene || !record.plan) return notFound(reply, "That shared room");
    return reply.send({
      name: record.name,
      plan: record.plan,
      scene: record.scene,
      tier: record.accuracyTier,
    });
  });

  // --- catalog ---------------------------------------------------------------
  app.get<{ Querystring: { query?: string; category?: string; fits?: string } }>(
    "/v1/catalog",
    async (request, reply) => {
      const { query, category, fits } = request.query;
      let items = [...CATALOG_ITEMS];
      if (category) items = items.filter((i) => i.category === category);
      if (query) {
        const needle = query.toLowerCase();
        items = items.filter((i) => i.name.toLowerCase().includes(needle) || i.category.includes(needle));
      }
      if (fits) {
        // "WxDxH" in metres: everything that fits inside the given envelope.
        const [w, d, h] = fits.split("x").map(Number);
        if ([w, d, h].every((n) => Number.isFinite(n) && n! > 0)) {
          items = items.filter(
            (i) => i.nativeSize.w <= w! && i.nativeSize.d <= d! && i.nativeSize.h <= h!,
          );
        }
      }
      // Immutable, content-hashed assets: safe to cache hard (docs/03 §7).
      return reply.header("cache-control", "public, max-age=3600").send(items);
    },
  );
}
