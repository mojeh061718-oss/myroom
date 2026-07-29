import * as THREE from "three";

/**
 * The "warm realistic-lite" environment (docs/02 §7), procedurally.
 *
 * three's RoomEnvironment is a neutral white studio lightbox — accurate and
 * clinical, and the single biggest reason the sandbox read flat and grey.
 * This is the same idea graded like late-afternoon interior light: one big
 * warm key panel (the "window wall"), a cool sky above, a warm floor bounce,
 * and dim side cards for gentle directional variation. Fed through
 * PMREMGenerator it becomes the scene's IBL — no HDRI download, so a cold
 * offline first load still lights correctly (docs/03 §6), which is what kept
 * the Poly Haven HDRI out (DECISIONS.md → "Procedural IBL before the HDRI
 * asset"). This closes that deferral with the warmth the HDRI was for.
 */
export function createWarmEnvironment(): THREE.Scene {
  const scene = new THREE.Scene();

  const shell = new THREE.Mesh(
    new THREE.BoxGeometry(30, 30, 30),
    new THREE.MeshBasicMaterial({ color: new THREE.Color(0.32, 0.3, 0.28), side: THREE.BackSide }),
  );
  scene.add(shell);

  const panel = (
    color: [number, number, number],
    intensity: number,
    size: [number, number],
    position: [number, number, number],
    lookAt: [number, number, number] = [0, 0, 0],
  ) => {
    const mesh = new THREE.Mesh(
      new THREE.PlaneGeometry(size[0], size[1]),
      new THREE.MeshBasicMaterial({
        color: new THREE.Color(...color).multiplyScalar(intensity),
        side: THREE.DoubleSide,
      }),
    );
    mesh.position.set(...position);
    mesh.lookAt(...lookAt);
    scene.add(mesh);
  };

  // The key: a tall warm "window" — late sun through glazing.
  panel([1.0, 0.86, 0.66], 7, [7, 6], [-13, 5, -4]);
  // A second, dimmer warm card beside it softens the key's edge.
  panel([1.0, 0.9, 0.74], 2.4, [5, 5], [-12, 4, 5]);
  // Cool sky overhead — the blue that makes the warm read warm.
  panel([0.62, 0.7, 0.85], 2.2, [16, 16], [0, 14, 0]);
  // Warm floor bounce, as if off wooden boards.
  panel([0.72, 0.58, 0.44], 1.4, [16, 16], [0, -14, 0]);
  // Cool fill card opposite the key, dim — shape without a second "sun".
  panel([0.55, 0.6, 0.72], 1.1, [6, 5], [13, 4, 3]);
  // A dim warm card behind the camera side for gentle wrap.
  panel([0.9, 0.8, 0.68], 0.9, [5, 4], [2, 3, 13]);

  return scene;
}

/** Dispose everything the environment scene allocated. */
export function disposeEnvironment(scene: THREE.Scene): void {
  scene.traverse((node) => {
    const mesh = node as THREE.Mesh;
    if (!mesh.isMesh) return;
    mesh.geometry.dispose();
    const material = mesh.material;
    if (Array.isArray(material)) material.forEach((m) => m.dispose());
    else material.dispose();
  });
}
