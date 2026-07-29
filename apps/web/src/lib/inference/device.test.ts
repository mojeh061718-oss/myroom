import { afterEach, describe, expect, it, vi } from "vitest";

import { detectInferenceTier, privacySentence, resetTierCache, wasmCapabilities } from "./device";

function withGPU(adapter: unknown) {
  Object.defineProperty(globalThis, "navigator", {
    configurable: true,
    value: { gpu: { requestAdapter: async () => adapter } },
  });
}

function withoutGPU() {
  Object.defineProperty(globalThis, "navigator", { configurable: true, value: {} });
}

const capableAdapter = {
  features: { has: (name: string) => name === "shader-f16" },
  limits: { maxBufferSize: 512 * 1024 * 1024 },
  info: { vendor: "apple", architecture: "metal-3" },
};

afterEach(() => {
  resetTierCache();
  vi.restoreAllMocks();
});

describe("inference tier detection", () => {
  it("uses the device GPU when WebGPU offers a capable adapter", async () => {
    withGPU(capableAdapter);
    const report = await detectInferenceTier({ force: true });
    expect(report.tier).toBe("webgpu");
    expect(report.webgpuAvailable).toBe(true);
    expect(report.adapter?.vendor).toBe("apple");
    expect(report.adapter?.shaderF16).toBe(true);
    expect(report.detail).toContain("apple");
    expect(report.reason).toBe("");
  });

  it("falls back to the CPU rather than refusing when there is no WebGPU", async () => {
    withoutGPU();
    const report = await detectInferenceTier({ force: true });
    // The whole point: no GPU is a slower tier, never an unavailable pipeline.
    expect(report.tier).toBe("wasm");
    expect(report.webgpuAvailable).toBe(false);
    expect(report.reason).toContain("WebGPU");
  });

  it("declines an adapter that cannot allocate what the depth model needs", async () => {
    withGPU({
      features: { has: () => false },
      limits: { maxBufferSize: 16 * 1024 * 1024 },
      info: { vendor: "tiny", architecture: "v1" },
    });
    const report = await detectInferenceTier({ force: true });
    // Better to fall back deliberately than to fail halfway through a job.
    expect(report.tier).toBe("wasm");
    expect(report.reason).toContain("MB");
  });

  it("still uses the GPU when the browser withholds adapter identity", async () => {
    withGPU({
      features: { has: () => false },
      limits: { maxBufferSize: 512 * 1024 * 1024 },
      info: {},
    });
    const report = await detectInferenceTier({ force: true });
    expect(report.tier).toBe("webgpu");
    expect(report.adapter?.vendor).toBe("unknown");
    // Privacy-gated vendor strings must not read as a broken adapter.
    expect(report.detail).not.toContain("unknown");
  });

  it("survives an adapter request that throws", async () => {
    Object.defineProperty(globalThis, "navigator", {
      configurable: true,
      value: {
        gpu: {
          requestAdapter: async () => {
            throw new Error("adapter exploded");
          },
        },
      },
    });
    const report = await detectInferenceTier({ force: true });
    expect(report.tier).toBe("wasm");
    expect(report.reason).toContain("adapter exploded");
  });

  it("treats a null adapter as absent rather than crashing", async () => {
    withGPU(null);
    const report = await detectInferenceTier({ force: true });
    expect(report.tier).toBe("wasm");
    expect(report.reason).toContain("no WebGPU adapter");
  });

  it("memoises, because probing costs an adapter request", async () => {
    const requestAdapter = vi.fn(async () => capableAdapter);
    Object.defineProperty(globalThis, "navigator", {
      configurable: true,
      value: { gpu: { requestAdapter } },
    });
    await detectInferenceTier({ force: true });
    await detectInferenceTier();
    await detectInferenceTier();
    expect(requestAdapter).toHaveBeenCalledTimes(1);
  });
});

describe("what we tell the user about their photos", () => {
  it("promises photos stay put on a local tier", async () => {
    withGPU(capableAdapter);
    const report = await detectInferenceTier({ force: true });
    const sentence = privacySentence(report);
    expect(sentence).toContain("never leave");
    expect(sentence).not.toContain("uploaded");
  });

  it("says plainly that photos are uploaded on the server tier", () => {
    const sentence = privacySentence({
      tier: "server",
      detail: "the reconstruction service",
      webgpuAvailable: false,
      adapter: null,
      reason: "old browser",
    });
    expect(sentence).toContain("uploaded");
    expect(sentence).toContain("deleted");
  });
});

describe("wasm capability probe", () => {
  it("reports SIMD and threads without throwing", () => {
    const caps = wasmCapabilities();
    expect(typeof caps.simd).toBe("boolean");
    expect(typeof caps.threads).toBe("boolean");
  });
});
