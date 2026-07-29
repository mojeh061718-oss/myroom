import { expect, test, type Page } from "@playwright/test";
import { boardBox, PPM } from "./board.js";

/**
 * Model import (docs/06 §5): a GLB dropped into the sandbox becomes a
 * first-class placed object that survives reload.
 */

/** Build a minimal valid GLB in memory: one 1 × 1 × 1 indexed cube. */
function cubeGlb(): Buffer {
  const positions = new Float32Array([
    0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0, // back face corners
    0, 0, 1, 1, 0, 1, 1, 1, 1, 0, 1, 1, // front face corners
  ]);
  const indices = new Uint16Array([
    0, 1, 2, 0, 2, 3, 4, 6, 5, 4, 7, 6, 0, 4, 5, 0, 5, 1,
    1, 5, 6, 1, 6, 2, 2, 6, 7, 2, 7, 3, 3, 7, 4, 3, 4, 0,
  ]);
  const posBytes = new Uint8Array(positions.buffer);
  const idxBytes = new Uint8Array(indices.buffer);
  const idxOffset = posBytes.byteLength;
  const binLength = idxOffset + idxBytes.byteLength;
  const binPadded = binLength + ((4 - (binLength % 4)) % 4);
  const bin = new Uint8Array(binPadded);
  bin.set(posBytes, 0);
  bin.set(idxBytes, idxOffset);

  const json = JSON.stringify({
    asset: { version: "2.0" },
    scene: 0,
    scenes: [{ nodes: [0] }],
    nodes: [{ mesh: 0 }],
    meshes: [{ primitives: [{ attributes: { POSITION: 0 }, indices: 1 }] }],
    accessors: [
      { bufferView: 0, componentType: 5126, count: 8, type: "VEC3", min: [0, 0, 0], max: [1, 1, 1] },
      { bufferView: 1, componentType: 5123, count: indices.length, type: "SCALAR" },
    ],
    bufferViews: [
      { buffer: 0, byteOffset: 0, byteLength: posBytes.byteLength },
      { buffer: 0, byteOffset: idxOffset, byteLength: idxBytes.byteLength },
    ],
    buffers: [{ byteLength: binPadded }],
  });
  const jsonBytes = new TextEncoder().encode(json);
  const jsonPadded = jsonBytes.byteLength + ((4 - (jsonBytes.byteLength % 4)) % 4);
  const jsonChunk = new Uint8Array(jsonPadded).fill(0x20);
  jsonChunk.set(jsonBytes, 0);

  const total = 12 + 8 + jsonPadded + 8 + binPadded;
  const out = new Uint8Array(total);
  const view = new DataView(out.buffer);
  view.setUint32(0, 0x46546c67, true); // glTF
  view.setUint32(4, 2, true);
  view.setUint32(8, total, true);
  view.setUint32(12, jsonPadded, true);
  view.setUint32(16, 0x4e4f534a, true); // JSON
  out.set(jsonChunk, 20);
  view.setUint32(20 + jsonPadded, binPadded, true);
  view.setUint32(24 + jsonPadded, 0x004e4942, true); // BIN
  out.set(bin, 28 + jsonPadded);
  return Buffer.from(out);
}

async function drawRoomAndOpenSandbox(page: Page) {
  await page.goto("/");
  await expect(page.getByTestId("tutorial")).toBeVisible({ timeout: 15_000 });
  await page.getByTestId("tutorial-skip").click();
  await page.getByTestId("new-room").click();
  await page.getByTestId("drawing-board").waitFor();

  const box = await boardBox(page);
  const click = (x: number, y: number) =>
    page.mouse.click(box.x + box.width / 2 + PPM * x, box.y + box.height / 2 - PPM * y);
  const w = box.width / 2 / PPM > 3.4 ? 2.6 : 1.8;
  const d = box.height / 2 / PPM > 3.4 ? 1.8 : 1.4;
  await click(-w, d);
  await click(w, d);
  await click(w, -d);
  await click(-w, -d);
  await click(-w, d);
  await page.getByTestId("height-8ft").click();
  await page.waitForTimeout(300);

  await page.goto(page.url().replace("/draw", ""));
  await page.getByTestId("sandbox").waitFor({ timeout: 25_000 });
}

test("an imported GLB becomes a placed object and survives reload", async ({ page }) => {
  await drawRoomAndOpenSandbox(page);

  await page.getByTestId("edit-button").click();
  await page.getByTestId("add-button").click();
  await expect(page.getByTestId("import-model")).toBeVisible();

  await page.getByTestId("import-model-input").setInputFiles({
    name: "grandpas-chair.glb",
    mimeType: "model/gltf-binary",
    buffer: cubeGlb(),
  });

  // The confirm sheet shows the detected size; accept it.
  await expect(page.getByTestId("import-height")).toBeVisible();
  await page.getByTestId("import-confirm").click();

  // The object is in the scene list, as a first-class item.
  await expect(page.locator(".scene-a11y-list")).toContainText("grandpas-chair");

  // And it survives a reload — the asset lives in IndexedDB.
  await page.waitForTimeout(400);
  await page.reload();
  await page.getByTestId("sandbox").waitFor({ timeout: 25_000 });
  await expect(page.locator(".scene-a11y-list")).toContainText("grandpas-chair");
});
