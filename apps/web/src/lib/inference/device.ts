/**
 * Where inference runs — and why the phone is a real answer.
 *
 * docs/05 §10 listed on-device reconstruction as a v1 non-goal, to "revisit
 * when WebGPU inference matures". It has: WebGPU ships enabled by default in
 * Safari on iOS 26, backed by Metal, so a modern iPhone's GPU is reachable from
 * this PWA with no native app and no server round trip. An A18 Pro has a
 * six-core GPU and a sixteen-core Neural Engine; the pipeline's vision models
 * are 25–150 M parameters. That is not a stretch for the device — it is a
 * comfortable fit.
 *
 * This module only *reports* what the device can do. The decision of what to
 * run where lives in the pipeline, because it depends on the job as well as the
 * hardware.
 *
 * Three tiers, best first:
 *
 * - `webgpu`  — the phone or laptop GPU, via Metal/Vulkan/D3D12. Fastest, and
 *               the photos never leave the device.
 * - `wasm`    — the same ONNX graphs on the CPU through WebAssembly SIMD.
 *               Slower, still local, still private.
 * - `server`  — hand the job to the API's worker tier. The only option on a
 *               browser too old for either of the above.
 *
 * Note what is *not* a tier: "an NVIDIA card". None of these paths requires
 * one, and the server tier does not either (see workers/vision/device.py).
 */

export type InferenceTier = "webgpu" | "wasm" | "server";

export interface AdapterInfo {
  vendor: string;
  architecture: string;
  /** Largest buffer the adapter will allocate, in bytes. */
  maxBufferSize: number;
  /** Whether 16-bit floats are available — halves memory and roughly doubles throughput. */
  shaderF16: boolean;
}

export interface TierReport {
  tier: InferenceTier;
  /** Human-readable, shown on the privacy screen so the user knows where their photos went. */
  detail: string;
  webgpuAvailable: boolean;
  /** Populated only when WebGPU is available. */
  adapter: AdapterInfo | null;
  /** Why we did not land on a faster tier, when we did not. */
  reason: string;
}

/**
 * `navigator.gpu` is not in the DOM lib for every TS version we build
 * against — and when three's WebGPU declarations are in the program they
 * type it differently, so this is a standalone structural view rather than
 * an extension of Navigator.
 */
interface NavigatorWithGPU {
  gpu?: {
    requestAdapter(options?: { powerPreference?: "low-power" | "high-performance" }): Promise<GPUAdapterLike | null>;
  };
}

interface GPUAdapterLike {
  features: { has(name: string): boolean };
  limits: { maxBufferSize?: number; maxStorageBufferBindingSize?: number };
  info?: { vendor?: string; architecture?: string };
  requestAdapterInfo?: () => Promise<{ vendor?: string; architecture?: string }>;
}

/**
 * A depth model at 518×518 needs roughly this much scratch space. An adapter
 * that cannot allocate it will fail mid-run rather than at load, so it is
 * cheaper to check up front and fall back deliberately.
 */
const MIN_BUFFER_BYTES = 128 * 1024 * 1024;

let cached: TierReport | null = null;

async function probeAdapter(): Promise<{ adapter: AdapterInfo | null; reason: string }> {
  const nav = navigator as NavigatorWithGPU;
  if (!nav.gpu) {
    return { adapter: null, reason: "this browser does not expose WebGPU" };
  }

  let handle: GPUAdapterLike | null = null;
  try {
    handle = await nav.gpu.requestAdapter({ powerPreference: "high-performance" });
  } catch (error) {
    return { adapter: null, reason: `WebGPU adapter request failed: ${String(error)}` };
  }
  if (!handle) {
    return { adapter: null, reason: "no WebGPU adapter available on this device" };
  }

  // `info` is the current shape; `requestAdapterInfo()` is the older one. Both
  // are optional, and neither is required for inference — they only make the
  // privacy screen specific.
  let vendor = handle.info?.vendor ?? "";
  let architecture = handle.info?.architecture ?? "";
  if (!vendor && typeof handle.requestAdapterInfo === "function") {
    try {
      const info = await handle.requestAdapterInfo();
      vendor = info.vendor ?? "";
      architecture = info.architecture ?? "";
    } catch {
      // Adapter info is privacy-gated in some browsers. Not knowing the vendor
      // is not a reason to refuse to use the GPU.
    }
  }

  const maxBufferSize = handle.limits.maxBufferSize ?? handle.limits.maxStorageBufferBindingSize ?? 0;
  if (maxBufferSize > 0 && maxBufferSize < MIN_BUFFER_BYTES) {
    return {
      adapter: null,
      reason: `WebGPU adapter caps buffers at ${Math.round(maxBufferSize / 1024 / 1024)} MB, below the ${
        MIN_BUFFER_BYTES / 1024 / 1024
      } MB the depth model needs`,
    };
  }

  return {
    adapter: {
      vendor: vendor || "unknown",
      architecture: architecture || "unknown",
      maxBufferSize,
      shaderF16: handle.features.has("shader-f16"),
    },
    reason: "",
  };
}

function wasmUsable(): boolean {
  // WebAssembly itself is universal in any browser this PWA supports; what
  // varies is threading, which needs cross-origin isolation.
  return typeof WebAssembly === "object" && typeof WebAssembly.instantiate === "function";
}

/** Whether SIMD + threads are available, which is a ~4x difference on the wasm tier. */
export function wasmCapabilities(): { simd: boolean; threads: boolean } {
  // `globalThis`, not `self`: this module is imported by unit tests and by the
  // service worker, and `self` is only defined in window and worker scopes.
  const threads =
    typeof SharedArrayBuffer !== "undefined" &&
    (globalThis as { crossOriginIsolated?: boolean }).crossOriginIsolated === true;
  // The canonical 8-byte SIMD feature-detection module.
  let simd = false;
  try {
    simd = WebAssembly.validate(
      new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0, 1, 5, 1, 96, 0, 1, 123, 3, 2, 1, 0, 10, 10, 1, 8, 0, 65, 0, 253, 15, 253, 98, 11]),
    );
  } catch {
    simd = false;
  }
  return { simd, threads };
}

/**
 * Detect the best tier this device offers. Cached — the answer cannot change
 * without a page reload, and probing costs an adapter request.
 */
export async function detectInferenceTier(options?: { force?: boolean }): Promise<TierReport> {
  if (cached && !options?.force) return cached;

  const { adapter, reason } = await probeAdapter();

  if (adapter) {
    const named = adapter.vendor !== "unknown" ? ` (${adapter.vendor} ${adapter.architecture})`.trimEnd() : "";
    cached = {
      tier: "webgpu",
      detail: `this device's GPU${named}${adapter.shaderF16 ? ", 16-bit" : ""}`,
      webgpuAvailable: true,
      adapter,
      reason: "",
    };
    return cached;
  }

  if (wasmUsable()) {
    const { simd, threads } = wasmCapabilities();
    const extras = [simd ? "SIMD" : null, threads ? "threads" : null].filter(Boolean).join(" + ");
    cached = {
      tier: "wasm",
      detail: `this device's CPU${extras ? ` (${extras})` : ""}`,
      webgpuAvailable: false,
      adapter: null,
      reason,
    };
    return cached;
  }

  cached = {
    tier: "server",
    detail: "the reconstruction service",
    webgpuAvailable: false,
    adapter: null,
    reason: reason || "no local inference runtime is available in this browser",
  };
  return cached;
}

/** Test seam — resets the memoised probe. */
export function resetTierCache(): void {
  cached = null;
}

/**
 * One sentence for the privacy screen (docs/01 §7). The honest version of
 * "where do my photos go", which differs per tier and so cannot be static copy.
 */
export function privacySentence(report: TierReport): string {
  return report.tier === "server"
    ? "Your photos are uploaded to our reconstruction service, processed, and deleted afterwards."
    : `Your photos are processed on ${report.detail} and never leave it.`;
}
