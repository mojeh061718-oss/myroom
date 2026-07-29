import * as THREE from "three";
import type { MeshData } from "@myroom/geometry";

/** MeshData (pure numbers from packages/geometry) → a three BufferGeometry. */
export function toBufferGeometry(mesh: MeshData): THREE.BufferGeometry {
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.Float32BufferAttribute(mesh.positions, 3));
  geo.setAttribute("normal", new THREE.Float32BufferAttribute(mesh.normals, 3));
  geo.setAttribute("uv", new THREE.Float32BufferAttribute(mesh.uvs, 2));
  geo.setIndex(mesh.indices);
  geo.computeBoundingSphere();
  geo.computeBoundingBox();
  return geo;
}
