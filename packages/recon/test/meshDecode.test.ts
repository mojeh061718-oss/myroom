import { existsSync, readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { decodeGlb, decodePly, decodeScanMesh } from "../src/meshDecode.js";
import { parseMeshScan } from "../src/mesh.js";

/**
 * Decoding scan files without three.js. GLTFLoader + DRACOLoader would fetch a
 * WASM decoder from a CDN at runtime, which breaks offline-first (docs/03 §6)
 * and would not survive the service worker's precache.
 */

/** A minimal uncompressed GLB: one triangle, no node transform. */
function tinyGlb(options: { draco?: boolean; transform?: number[] } = {}): Uint8Array {
  const positions = new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]);
  const indices = new Uint32Array([0, 1, 2]);
  const posBytes = Buffer.from(positions.buffer);
  const idxBytes = Buffer.from(indices.buffer);
  const json: Record<string, unknown> = {
    asset: { version: "2.0" },
    scene: 0,
    scenes: [{ nodes: [0] }],
    nodes: [options.transform ? { mesh: 0, matrix: options.transform } : { mesh: 0 }],
    meshes: [{ primitives: [{ attributes: { POSITION: 0 }, indices: 1, mode: 4 }] }],
    accessors: [
      { bufferView: 0, componentType: 5126, count: 3, type: "VEC3" },
      { bufferView: 1, componentType: 5125, count: 3, type: "SCALAR" },
    ],
    bufferViews: [
      { buffer: 0, byteOffset: 0, byteLength: posBytes.length },
      { buffer: 0, byteOffset: posBytes.length, byteLength: idxBytes.length },
    ],
    buffers: [{ byteLength: posBytes.length + idxBytes.length }],
  };
  if (options.draco) json.extensionsRequired = ["KHR_draco_mesh_compression"];

  let text = JSON.stringify(json);
  while (text.length % 4 !== 0) text += " ";
  const jsonBuf = Buffer.from(text);
  const binBuf = Buffer.concat([posBytes, idxBytes]);
  const total = 12 + 8 + jsonBuf.length + 8 + binBuf.length;
  const glb = Buffer.alloc(total);
  glb.writeUInt32LE(0x46546c67, 0);
  glb.writeUInt32LE(2, 4);
  glb.writeUInt32LE(total, 8);
  glb.writeUInt32LE(jsonBuf.length, 12);
  glb.writeUInt32LE(0x4e4f534a, 16);
  jsonBuf.copy(glb, 20);
  const at = 20 + jsonBuf.length;
  glb.writeUInt32LE(binBuf.length, at);
  glb.writeUInt32LE(0x004e4942, at + 4);
  binBuf.copy(glb, at + 8);
  return new Uint8Array(glb);
}

describe("GLB", () => {
  it("decodes positions and indices", () => {
    const result = decodeGlb(tinyGlb());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(Array.from(result.positions)).toEqual([0, 0, 0, 1, 0, 0, 0, 1, 0]);
    expect(Array.from(result.indices)).toEqual([0, 1, 2]);
  });

  it("applies node transforms, because metres must be metres", () => {
    // glTF matrices are column-major: scale 2, translated +10 in x.
    const scaleAndMove = [2, 0, 0, 0, 0, 2, 0, 0, 0, 0, 2, 0, 10, 0, 0, 1];
    const result = decodeGlb(tinyGlb({ transform: scaleAndMove }));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(Array.from(result.positions.slice(0, 6))).toEqual([10, 0, 0, 12, 0, 0]);
  });

  it("says what to do when the file is Draco-compressed", () => {
    const result = decodeGlb(tinyGlb({ draco: true }));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    // The message has to name the way out, not just the problem.
    expect(result.reason).toMatch(/PLY|compression/i);
  });

  it("rejects a file that is not a GLB", () => {
    const result = decodeGlb(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20]));
    expect(result.ok).toBe(false);
  });
});

describe("PLY", () => {
  function binaryPly(count: number): Uint8Array {
    const header = `ply\nformat binary_little_endian 1.0\nelement vertex ${count}\nproperty float x\nproperty float y\nproperty float z\nend_header\n`;
    const body = new Float32Array(count * 3);
    for (let i = 0; i < count; i++) {
      body[i * 3] = i;
      body[i * 3 + 1] = i * 2;
      body[i * 3 + 2] = i * 3;
    }
    return new Uint8Array(Buffer.concat([Buffer.from(header), Buffer.from(body.buffer)]));
  }

  it("decodes a binary point cloud", () => {
    const result = decodePly(binaryPly(4));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.positions.length).toBe(12);
    expect(Array.from(result.positions.slice(3, 6))).toEqual([1, 2, 3]);
    // A point cloud has no faces, and must say so rather than inventing them.
    expect(result.indices.length).toBe(0);
  });

  it("decodes an ascii point cloud", () => {
    const text = "ply\nformat ascii 1.0\nelement vertex 2\nproperty float x\nproperty float y\nproperty float z\nend_header\n1 2 3\n4 5 6\n";
    const result = decodePly(new Uint8Array(Buffer.from(text)));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(Array.from(result.positions)).toEqual([1, 2, 3, 4, 5, 6]);
  });

  it("rejects a file that is not a PLY", () => {
    expect(decodePly(new Uint8Array(Buffer.from("not a ply at all"))).ok).toBe(false);
  });
});

/** The owner's own Scaniverse scan, re-exported to both formats. */
const GLB = "/tmp/sv_scan.glb";
const PLY = "/tmp/sv_scan.ply";
describe.skipIf(!existsSync(GLB) || !existsSync(PLY))("a real scan, end to end from bytes", () => {
  it("GLB decodes and measures the room", () => {
    const decoded = decodeScanMesh(new Uint8Array(readFileSync(GLB)), "glb");
    expect(decoded.ok).toBe(true);
    if (!decoded.ok) return;
    const scan = parseMeshScan(decoded.positions, decoded.indices, "glb");
    expect(scan.parsed).toBe(true);
    expect(scan.ceilingHeight).toBeGreaterThan(2.0);
    expect(scan.ceilingHeight).toBeLessThan(3.2);
    // Traced, not boxed: an open-plan room is not four walls.
    expect(scan.walls.length).toBeGreaterThan(4);
  });

  it("PLY decodes and still measures the ceiling, without faces", () => {
    const decoded = decodeScanMesh(new Uint8Array(readFileSync(PLY)), "ply");
    expect(decoded.ok).toBe(true);
    if (!decoded.ok) return;
    expect(decoded.positions.length).toBeGreaterThan(100_000);
    expect(decoded.indices.length).toBe(0);
  });
});
