import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { ReconstructBody, type ReconstructionJob } from "@myroom/schema";
import type { Store } from "../store.js";
import type { EventBus } from "../jobs/queue.js";
import { runReconstruction, type StageWorkers } from "../jobs/orchestrator.js";
import { invalid, notFound, problem } from "../problem.js";

/** docs/03 §3: 10 reconstructions per project per day. */
export const RECONSTRUCTS_PER_DAY = 10;

export function registerReconstructRoutes(
  app: FastifyInstance,
  deps: {
    store: Store;
    bus: EventBus;
    workers: StageWorkers;
    now: () => string;
    newId: () => string;
    requireOwner: (request: FastifyRequest, reply: FastifyReply, projectId: string) => Promise<string | null>;
    requireSession: (request: FastifyRequest, reply: FastifyReply) => Promise<string | null>;
    /** awaited by tests so assertions don't race the pipeline */
    track?: (work: Promise<unknown>) => void;
  },
): void {
  const { store, bus, workers, now, newId } = deps;

  app.post<{ Params: { id: string } }>("/v1/projects/:id/reconstruct", async (request, reply) => {
    const ownerId = await deps.requireOwner(request, reply, request.params.id);
    if (!ownerId) return reply;

    const body = ReconstructBody.safeParse(request.body ?? {});
    if (!body.success) return invalid(reply, "Tell us which photos to use.");

    const project = await store.getProject(ownerId, request.params.id);
    if (!project?.plan) {
      return invalid(reply, "Draw and close the room before building it.");
    }

    const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    if ((await store.countJobsSince(request.params.id, since)) >= RECONSTRUCTS_PER_DAY) {
      return problem(reply, {
        type: "https://myroom.app/problems/rate-limited",
        title: "Daily limit reached",
        status: 429,
        detail: `This project has been rebuilt ${RECONSTRUCTS_PER_DAY} times today. Try again tomorrow.`,
      });
    }

    const uploads = await store.listUploads(request.params.id);
    const photoIds = body.data.photoIds.filter((id) =>
      uploads.some((u) => u.id === id && u.kind === "photo" && u.status === "stored"),
    );
    const lidarId =
      body.data.lidarId && uploads.some((u) => u.id === body.data.lidarId && u.kind === "lidar" && u.status === "stored")
        ? body.data.lidarId
        : null;

    const job: ReconstructionJob = {
      id: newId(),
      projectId: request.params.id,
      status: "queued",
      stage: "queued",
      createdAt: now(),
      finishedAt: null,
      warnings: [],
      sceneId: null,
      tier: lidarId ? "lidar" : photoIds.length > 0 ? "photo" : "sketch",
    };
    await store.createJob(job);

    // The in-process driver starts the work immediately; the BullMQ driver
    // would enqueue here instead (docs/03 §4). Either way the response is the
    // job id and the client follows progress over SSE.
    const work = runReconstruction({
      store,
      bus,
      workers,
      job: { jobId: job.id, projectId: request.params.id, ownerId, photoIds, lidarId },
      now,
      newId,
    }).catch((error) => {
      bus.publish(job.id, { type: "error", message: "Something went wrong building your room. Your plan is safe." });
      void store.updateJob(job.id, { status: "failed", finishedAt: now(), warnings: [String(error)] });
    });
    deps.track?.(work);

    return reply.code(202).send({ jobId: job.id, status: job.status });
  });

  app.get<{ Params: { jobId: string } }>("/v1/jobs/:jobId", async (request, reply) => {
    const userId = await deps.requireSession(request, reply);
    if (!userId) return reply;
    const job = await store.getJob(request.params.jobId);
    if (!job) return notFound(reply, "That job");
    const project = await store.getProject(userId, job.projectId);
    if (!project) return notFound(reply, "That job");
    return reply.send(job);
  });

  /**
   * SSE progress stream (docs/03 §5). One-directional, proxy-friendly, and
   * resumable: `Last-Event-ID` replays everything the client missed, so a
   * backgrounded phone reconnects without losing the object discoveries.
   */
  app.get<{ Params: { jobId: string } }>("/v1/jobs/:jobId/events", async (request, reply) => {
    const userId = await deps.requireSession(request, reply);
    if (!userId) return reply;
    const job = await store.getJob(request.params.jobId);
    if (!job) return notFound(reply, "That job");
    const project = await store.getProject(userId, job.projectId);
    if (!project) return notFound(reply, "That job");

    const lastEventId = Number(request.headers["last-event-id"] ?? 0) || 0;

    reply.raw.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      // Proxies that buffer would defeat the point of streaming progress.
      "x-accel-buffering": "no",
    });
    reply.hijack();

    const send = (id: number, event: unknown) => {
      reply.raw.write(`id: ${id}\ndata: ${JSON.stringify(event)}\n\n`);
    };
    // The replay in `subscribe` runs synchronously, before it has returned an
    // unsubscribe function — so a job that already finished has to be able to
    // close the stream after the fact, or the client waits forever for bytes
    // that will never come.
    let finished = false;
    let unsubscribe = () => {};
    unsubscribe = bus.subscribe(request.params.jobId, lastEventId, (id, event) => {
      send(id, event);
      if (event.type === "done" || event.type === "error") {
        finished = true;
        unsubscribe();
        reply.raw.end();
      }
    });
    if (finished) unsubscribe();
    // A comment frame keeps intermediaries from closing an idle stream.
    const heartbeat = setInterval(() => reply.raw.write(": keep-alive\n\n"), 15000);
    heartbeat.unref?.();
    request.raw.on("close", () => {
      clearInterval(heartbeat);
      unsubscribe();
    });
    return reply;
  });
}
