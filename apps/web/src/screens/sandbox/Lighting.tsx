import { useEffect, useMemo } from "react";
import * as THREE from "three";
import { useThree } from "@react-three/fiber";
import { ContactShadows } from "@react-three/drei";
import { RoomEnvironment } from "three/examples/jsm/environments/RoomEnvironment.js";
import type { ShellGeometry } from "@myroom/geometry";

/**
 * "Warm realistic-lite" lighting (docs/02 §7): image-based ambient light plus
 * one soft directional key through the room's window openings, gentle contact
 * shadows, ACES filmic tone mapping.
 *
 * The IBL is generated procedurally from three's RoomEnvironment rather than
 * loading an HDRI file — it needs no network fetch, so a cold, offline first
 * load still lights correctly (docs/03 §6). The curated Poly Haven CC0 HDRI
 * lands in M6 alongside the rest of the visual polish.
 * See DECISIONS.md → "Procedural IBL before the HDRI asset".
 */
/**
 * Exterior backdrop. Without it, a door or window opens onto pure background
 * and reads as a black hole punched in the wall rather than a way outside.
 * A soft vertical gradient keeps the dollhouse sitting on a dark, premium
 * ground while giving openings something luminous beyond them.
 * See DECISIONS.md → "Gradient exterior backdrop".
 */
function Backdrop({ radius }: { radius: number }) {
  const texture = useMemo(() => {
    const canvas = document.createElement("canvas");
    canvas.width = 4;
    canvas.height = 256;
    const ctx = canvas.getContext("2d")!;
    const grad = ctx.createLinearGradient(0, canvas.height, 0, 0);
    grad.addColorStop(0, "#15171B"); // ground, well below the horizon
    grad.addColorStop(0.42, "#2A2E35");
    grad.addColorStop(0.52, "#7C8794"); // horizon band — what a doorway frames
    grad.addColorStop(1, "#B6C0CD"); // soft daylight above
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    const tex = new THREE.CanvasTexture(canvas);
    tex.colorSpace = THREE.SRGBColorSpace;
    return tex;
  }, []);

  useEffect(() => () => texture.dispose(), [texture]);

  return (
    <mesh name="backdrop" renderOrder={-1} frustumCulled={false}>
      <sphereGeometry args={[radius, 24, 16]} />
      <meshBasicMaterial map={texture} side={THREE.BackSide} depthWrite={false} toneMapped={false} />
    </mesh>
  );
}

export function Lighting({ shell }: { shell: ShellGeometry }) {
  const gl = useThree((s) => s.gl);
  const scene = useThree((s) => s.scene);

  useEffect(() => {
    const pmrem = new THREE.PMREMGenerator(gl);
    pmrem.compileEquirectangularShader();
    const room = new RoomEnvironment();
    const envMap = pmrem.fromScene(room, 0.04).texture;
    scene.environment = envMap;
    return () => {
      scene.environment = null;
      envMap.dispose();
      pmrem.dispose();
      room.traverse((o) => {
        if (o instanceof THREE.Mesh) {
          o.geometry?.dispose?.();
          const m = o.material;
          if (Array.isArray(m)) m.forEach((x) => x.dispose());
          else m?.dispose?.();
        }
      });
    };
  }, [gl, scene]);

  const [cx, , cz] = shell.center;
  const span = Math.max(
    shell.bounds.max[0] - shell.bounds.min[0],
    shell.bounds.max[2] - shell.bounds.min[2],
    2,
  );

  /**
   * Key light direction: aimed inward through the widest window, so daylight
   * genuinely arrives from where the room's glazing is (docs/02 §7). Falls back
   * to a pleasant default angle for a windowless room.
   */
  const keyPosition = useMemo<[number, number, number]>(() => {
    let best: { area: number; pos: [number, number, number] } | null = null;
    for (const wall of shell.walls) {
      const mx = (wall.start[0] + wall.end[0]) / 2;
      const mz = (wall.start[2] + wall.end[2]) / 2;
      // Outward = away from the room, so the light sits outside shining in.
      const ox = -wall.inwardNormal[0];
      const oz = -wall.inwardNormal[2];
      const area = wall.length * wall.height;
      if (!best || area > best.area) {
        best = { area, pos: [mx + ox * span * 1.1, wall.height * 1.6, mz + oz * span * 1.1] };
      }
    }
    return best?.pos ?? [cx + span, span, cz + span];
  }, [shell, span, cx, cz]);

  return (
    <>
      <Backdrop radius={Math.max(span * 6, 40)} />
      {/* Soft fill so shadowed corners never go muddy. */}
      <ambientLight intensity={0.25} color="#fff4e6" />
      <directionalLight
        position={keyPosition}
        intensity={1.7}
        color="#fff1dd"
        castShadow
        shadow-mapSize={[1024, 1024]}
        shadow-bias={-0.0008}
        shadow-camera-near={0.1}
        shadow-camera-far={span * 4}
        shadow-camera-left={-span}
        shadow-camera-right={span}
        shadow-camera-top={span}
        shadow-camera-bottom={-span}
      />
      <ContactShadows
        position={[cx, 0.002, cz]}
        scale={span * 1.6}
        resolution={1024}
        blur={2.6}
        opacity={0.42}
        far={shell.height}
        frames={1}
      />
    </>
  );
}
