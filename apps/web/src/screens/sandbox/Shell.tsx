import { useEffect, useMemo, useRef } from "react";
import * as THREE from "three";
import { useFrame } from "@react-three/fiber";
import type { ShellGeometry } from "@myroom/geometry";
import { toBufferGeometry } from "./shellGeometry.js";
import { floorPatternFor } from "./EditSheets.js";
import { floorTextures, TILE_WORLD_M, wallRoughnessMap } from "./proceduralTextures.js";

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
 * Shell UVs are plan metres, so a repeat of 1/TILE_WORLD_M puts every
 * procedural texture at true world scale — planks read as planks (docs/06 §4).
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

  // Floor pattern follows the chosen swatch; custom hex colours stay flat.
  const floorMaps = useMemo(() => {
    const pair = floorTextures(floorPatternFor(finishes.floorColor));
    if (pair) {
      const repeat = 1 / TILE_WORLD_M;
      pair.map.repeat.set(repeat, repeat);
      pair.roughnessMap.repeat.set(repeat, repeat);
    }
    return pair;
  }, [finishes.floorColor]);

  const wallRoughness = useMemo(() => {
    const texture = wallRoughnessMap();
    texture.repeat.set(1 / 2.4, 1 / 2.4);
    return texture;
  }, []);

  const wallRefs = useRef<(THREE.Mesh | null)[]>([]);
  const camDir = useRef(new THREE.Vector3());

  /**
   * Wall fade (docs/06 §2): a wall standing between the camera and the room
   * interior drops to 15% opacity rather than blocking the view. The test is
   * which side of the wall plane the camera is on — its inward normal points
   * into the room, so a camera outside the room reads negative.
   *
   * Materials are created `transparent` and stay that way: `transparent` and
   * `depthWrite` are render-state flags, not shader inputs, so the fade never
   * needs a program recompile (the old per-frame `needsUpdate` could hitch
   * mid-gesture).
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
      mat.depthWrite = mat.opacity >= 0.995;
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
            roughnessMap={wallRoughness}
            metalness={0}
            envMapIntensity={0.4}
            side={THREE.DoubleSide}
            transparent
          />
        </mesh>
      ))}

      <mesh name="floor" geometry={geometries.floor} receiveShadow userData={{ kind: "floor" }}>
        <meshStandardMaterial
          // Remount when the pattern changes: adding/removing a map changes
          // the shader program, which a prop update alone doesn't rebuild.
          key={floorPatternFor(finishes.floorColor)}
          color={finishes.floorColor}
          map={floorMaps?.map ?? null}
          roughnessMap={floorMaps?.roughnessMap ?? null}
          roughness={0.75}
          metalness={0}
          envMapIntensity={0.55}
        />
      </mesh>

      {!dollhouse && (
        <mesh name="ceiling" geometry={geometries.ceiling} receiveShadow userData={{ kind: "ceiling" }}>
          <meshStandardMaterial color={finishes.ceilingColor} roughness={0.95} metalness={0} envMapIntensity={0.35} />
        </mesh>
      )}
    </group>
  );
}
