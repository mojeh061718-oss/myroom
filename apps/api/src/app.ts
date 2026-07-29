import Fastify, { type FastifyInstance, type FastifyRequest, type FastifyReply } from "fastify";
import cookie from "@fastify/cookie";
import { z } from "zod";
import {
  CreateProjectBody,
  RenameProjectBody,
  RoomPlanSchema,
  labelWallsForPlan,
} from "@myroom/schema";
import { createMemoryStore, type Store } from "./store.js";
import { createMemoryBlobs, type Blobs } from "./blobs.js";
import { createMemoryEventBus, type EventBus } from "./jobs/queue.js";
import { createDemoWorkers, type StageWorkers } from "./jobs/orchestrator.js";
import { registerUploadRoutes } from "./routes/uploads.js";
import { registerReconstructRoutes } from "./routes/reconstruct.js";
import { registerSceneRoutes } from "./routes/scene.js";
import { clearSession, devAuthEnabled, issueSession, readSession } from "./auth.js";
import { invalid, notFound, problem, unauthorized } from "./problem.js";

export interface AppOptions {
  store?: Store;
  blobs?: Blobs;
  bus?: EventBus;
  /** the GPU tier's stand-in; defaults to the CPU-only demo driver */
  workers?: StageWorkers;
  /** injected so tests get deterministic ids/timestamps */
  now?: () => string;
  newId?: () => string;
  /** collects in-flight pipeline runs so tests can await them */
  track?: (work: Promise<unknown>) => void;
}

const uuidv7 = (): string => {
  const ts = BigInt(Date.now());
  const b = new Uint8Array(16);
  crypto.getRandomValues(b);
  for (let i = 0; i < 6; i++) b[i] = Number((ts >> BigInt(40 - i * 8)) & 0xffn);
  b[6] = (b[6]! & 0x0f) | 0x70;
  b[8] = (b[8]! & 0x3f) | 0x80;
  const hex = [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
};

export async function buildApp(opts: AppOptions = {}): Promise<FastifyInstance> {
  const store = opts.store ?? createMemoryStore();
  const now = opts.now ?? (() => new Date().toISOString());
  const newId = opts.newId ?? uuidv7;

  const blobs = opts.blobs ?? createMemoryBlobs();
  const bus = opts.bus ?? createMemoryEventBus();
  const workers = opts.workers ?? createDemoWorkers(newId);

  const app = Fastify({ logger: false });
  await app.register(cookie);
  // Upload bodies arrive as opaque bytes on the presigned-PUT route, under
  // whatever content type the browser chose. JSON still goes through Fastify's
  // own parser; this only catches what it would otherwise refuse with a 415.
  app.addContentTypeParser("*", { parseAs: "buffer" }, (_req, body, done) => done(null, body));

  /** Every /v1 route except auth requires a session. */
  async function requireSession(request: FastifyRequest, reply: FastifyReply): Promise<string | null> {
    const session = await readSession(request);
    if (!session) {
      unauthorized(reply);
      return null;
    }
    return session.userId;
  }

  /** Session plus ownership of the addressed project. */
  async function requireOwner(
    request: FastifyRequest,
    reply: FastifyReply,
    projectId: string,
  ): Promise<string | null> {
    const userId = await requireSession(request, reply);
    if (!userId) return null;
    const project = await store.getProject(userId, projectId);
    if (!project) {
      notFound(reply, "That project");
      return null;
    }
    return userId;
  }

  app.get("/health", async () => ({ ok: true }));

  // --- auth -----------------------------------------------------------------
  // M1: magic-link request/redeem. The link is delivered by email in the hosted
  // build; in dev the token is returned so the flow is testable end to end.
  const magicTokens = new Map<string, string>();

  app.post("/v1/auth/magic-link", async (request, reply) => {
    const body = z.object({ email: z.string().email() }).safeParse(request.body);
    if (!body.success) return invalid(reply, "A valid email address is required.");
    const token = newId();
    magicTokens.set(token, body.data.email);
    // The token is the credential. It goes back in the response only when
    // someone has explicitly asked for dev auth (see auth.ts devAuthEnabled);
    // otherwise the hosted build delivers it by email and this route says
    // nothing an unauthenticated caller could sign in with.
    return reply.send({ sent: true, ...(devAuthEnabled() ? { token } : {}) });
  });

  app.post("/v1/auth/session", async (request, reply) => {
    const body = z.object({ token: z.string().min(1) }).safeParse(request.body);
    if (!body.success) return invalid(reply, "A sign-in token is required.");
    const email = magicTokens.get(body.data.token);
    if (!email) {
      return problem(reply, {
        type: "https://myroom.app/problems/invalid-token",
        title: "Sign-in link expired",
        status: 401,
        detail: "That sign-in link has already been used or has expired. Request a new one.",
      });
    }
    magicTokens.delete(body.data.token);
    await issueSession(reply, email);
    return reply.send({ userId: email });
  });

  app.delete("/v1/auth/session", async (_request, reply) => {
    clearSession(reply);
    return reply.code(204).send();
  });

  // --- projects -------------------------------------------------------------
  app.post("/v1/projects", async (request, reply) => {
    const userId = await requireSession(request, reply);
    if (!userId) return reply;
    const body = CreateProjectBody.safeParse(request.body);
    if (!body.success) return invalid(reply, "A project name is required.");
    const project = await store.createProject(userId, body.data.name, newId(), now());
    return reply.code(201).send(project);
  });

  app.get("/v1/projects", async (request, reply) => {
    const userId = await requireSession(request, reply);
    if (!userId) return reply;
    return reply.send(await store.listProjects(userId));
  });

  app.get<{ Params: { id: string } }>("/v1/projects/:id", async (request, reply) => {
    const userId = await requireSession(request, reply);
    if (!userId) return reply;
    const project = await store.getProject(userId, request.params.id);
    if (!project) return notFound(reply, "That project");
    return reply.header("etag", `W/"${project.planVersion}"`).send(project);
  });

  app.patch<{ Params: { id: string } }>("/v1/projects/:id", async (request, reply) => {
    const userId = await requireSession(request, reply);
    if (!userId) return reply;
    const body = RenameProjectBody.safeParse(request.body);
    if (!body.success) return invalid(reply, "A project name is required.");
    const project = await store.renameProject(userId, request.params.id, body.data.name, now());
    if (!project) return notFound(reply, "That project");
    return reply.send(project);
  });

  app.delete<{ Params: { id: string } }>("/v1/projects/:id", async (request, reply) => {
    const userId = await requireSession(request, reply);
    if (!userId) return reply;
    const deleted = await store.deleteProject(userId, request.params.id);
    if (!deleted) return notFound(reply, "That project");
    // Deletion is real: uploads and derived data purge within 24 h (docs/03 §7).
    return reply.code(204).send();
  });

  // --- plan -----------------------------------------------------------------
  app.put<{ Params: { id: string } }>("/v1/projects/:id/plan", async (request, reply) => {
    const userId = await requireSession(request, reply);
    if (!userId) return reply;

    // The plan is validated by packages/schema — the same schema the client and
    // the Python workers use (docs/03 §2). A plan that fails here can never
    // reach the pipeline and poison downstream scale (docs/04 §6).
    const parsed = RoomPlanSchema.safeParse(request.body);
    if (!parsed.success) {
      return invalid(
        reply,
        "This floor plan isn't valid yet — close the room and check the wall dimensions.",
        parsed.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })),
      );
    }
    // Wall labels drive guided capture (docs/04 §5); recompute server-side so a
    // stale or hand-edited client can't desynchronize them from the geometry.
    const plan = labelWallsForPlan(parsed.data);
    const project = await store.savePlan(userId, request.params.id, plan, now());
    if (!project) return notFound(reply, "That project");
    return reply.header("etag", `W/"${project.planVersion}"`).send(project);
  });

  // --- capture, pipeline, scene ---------------------------------------------
  registerUploadRoutes(app, {
    store,
    blobs,
    now,
    newId,
    requireOwner: requireOwner as (r: unknown, p: unknown, id: string) => Promise<string | null>,
  });
  registerReconstructRoutes(app, { store, bus, workers, now, newId, requireOwner, requireSession, track: opts.track });
  registerSceneRoutes(app, { store, now, newId, requireOwner });

  return app;
}
