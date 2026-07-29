import { useEffect, useMemo, useRef } from "react";
import * as THREE from "three";
import { useFrame } from "@react-three/fiber";
import type { ShellGeometry } from "@myroom/geometry";
import { toBufferGeometry } from "./shellGeometry.js";

export interface Finishes {
  wallColors: Record<string, string>;
  defaultWallColor: string;
  floorColor: string;
  ceilingColor: string;
}

interface Props {
  shell: ShellGeometry;
  finishes: Finishes;
  /** dollhouse hides the ceiling and fades near walls (docs/06 §2) */
  dollhouse: boolean;
  wallFade: boolean;
}

const FADE_OPACITY = 0.15;
const FADE_SPEED = 8; // per second, exponential approach

/**
 * The room shell (docs/06 §1). Each wall is its own mesh with its own material
 * so it can be painted individually (docs/06 §4) and faded independently.
 */
export function Shell({ shell, finishes, dollhouse, wallFade }: Props) {
  const geometries = useMemo(
    () => ({
      walls: shell.walls.map((w) => ({ wall: w, geometry: toBufferGeometry(w.mesh) })),
      floor: toBufferGeometry(shell.floor),
      ceiling: toBufferGeometry(shell.ceiling),
    }),
    [shell],
  );

  useEffect(() => {
    const g = geometries;
    return () => {
      g.walls.forEach((w) => w.geometry.dispose());
      g.floor.dispose();
      g.ceiling.dispose();
    };
  }, [geometries]);

  const wallRefs = useRef<(THREE.Mesh | null)[]>([]);
  const camDir = useRef(new THREE.Vector3());

  /**
   * Wall fade (docs/06 §2): a wall standing between the camera and the room
   * interior drops to 15% opacity rather than blocking the view. The test is
   * which side of the wall plane the camera is on — its inward normal points
   * into the room, so a camera outside the room reads negative.
   */
  useFrame((state, delta) => {
    const shouldFade = dollhouse && wallFade;
    const k = 1 - Math.exp(-FADE_SPEED * delta);
    geometries.walls.forEach((entry, i) => {
      const mesh = wallRefs.current[i];
      if (!mesh) return;
      const mat = mesh.material as THREE.MeshStandardMaterial;
      let target = 1;
      if (shouldFade) {
        const w = entry.wall;
        camDir.current.set(
          state.camera.position.x - (w.start[0] + w.end[0]) / 2,
          0,
          state.camera.position.z - (w.start[2] + w.end[2]) / 2,
        );
        const side = camDir.current.x * w.inwardNormal[0] + camDir.current.z * w.inwardNormal[2];
        if (side < 0) target = FADE_OPACITY;
      }
      mat.opacity += (target - mat.opacity) * k;
      const transparent = mat.opacity < 0.995;
      if (mat.transparent !== transparent) {
        mat.transparent = transparent;
        mat.depthWrite = !transparent;
        mat.needsUpdate = true;
      }
    });
  });

  return (
    <group name="shell">
      {geometries.walls.map((entry, i) => (
        <mesh
          key={entry.wall.wallId}
          name={`wall-${entry.wall.label}`}
          ref={(m) => {
            wallRefs.current[i] = m;
          }}
          geometry={entry.geometry}
          castShadow
          receiveShadow
          userData={{ kind: "wall", wallId: entry.wall.wallId, label: entry.wall.label }}
        >
          <meshStandardMaterial
            color={finishes.wallColors[entry.wall.wallId] ?? finishes.defaultWallColor}
            roughness={0.92}
            metalness={0}
            side={THREE.DoubleSide}
          />
        </mesh>
      ))}

      <mesh name="floor" geometry={geometries.floor} receiveShadow userData={{ kind: "floor" }}>
        <meshStandardMaterial color={finishes.floorColor} roughness={0.75} metalness={0} />
      </mesh>

      {!dollhouse && (
        <mesh name="ceiling" geometry={geometries.ceiling} userData={{ kind: "ceiling" }}>
          <meshStandardMaterial color={finishes.ceilingColor} roughness={0.95} metalness={0} />
        </mesh>
      )}
    </group>
  );
}
