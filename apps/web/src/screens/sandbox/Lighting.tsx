import { useEffect, useMemo } from "react";
import * as THREE from "three";
import { useThree } from "@react-three/fiber";
import { ContactShadows, SoftShadows } from "@react-three/drei";
import type { ShellGeometry } from "@myroom/geometry";
import { createWarmEnvironment, disposeEnvironment } from "./WarmEnvironment.js";
import type { QualityLevel } from "./quality.js";

/**
 * "Warm realistic-lite" lighting (docs/02 §7): warm image-based ambient
 * light, a soft directional key aimed through the room's actual glazing,
 * a cool bounce, live contact shadows, PCSS soft shadows at the higher
 * quality levels, ACES filmic tone mapping (set on the Canvas).
 *
 * Everything is procedural — no HDRI fetch — so a cold, offline first load
 * still lights correctly (docs/03 §6).
 */

/**
 * Exterior backdrop. Without it, a door or window opens onto pure background
 * and reads as a black hole punched in the wall rather than a way outside.
 * A soft vertical gradient keeps the dollhouse sitting on a dark, premium
 * ground while giving openings something luminous beyond them.
 * See DECISIONS.md → "Gradient exterior backdrop".
 */
function Backdrop({ radius, center }: { radius: number; center: [number, number, number] }) {
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

  // Centred on the room, not the world origin — a plan drawn away from the
  // origin used to get an off-axis horizon through its windows.
  return (
    <mesh name="backdrop" position={[center[0], 0, center[2]]} renderOrder={-1} frustumCulled={false}>
      <sphereGeometry args={[radius, 24, 16]} />
      <meshBasicMaterial map={texture} side={THREE.BackSide} depthWrite={false} toneMapped={false} />
    </mesh>
  );
}

export function Lighting({ shell, quality }: { shell: ShellGeometry; quality: QualityLevel }) {
  const gl = useThree((s) => s.gl);
  const scene = useThree((s) => s.scene);

  useEffect(() => {
    const pmrem = new THREE.PMREMGenerator(gl);
    pmrem.compileCubemapShader();
    const environment = createWarmEnvironment();
    const envMap = pmrem.fromScene(environment, 0.04).texture;
    scene.environment = envMap;
    return () => {
      scene.environment = null;
      envMap.dispose();
      pmrem.dispose();
      disposeEnvironment(environment);
    };
  }, [gl, scene]);

  const [cx, , cz] = shell.center;
  const span = Math.max(
    shell.bounds.max[0] - shell.bounds.min[0],
    shell.bounds.max[2] - shell.bounds.min[2],
    2,
  );

  /**
   * Key light direction: aimed inward through the wall with the most glazing,
   * so daylight genuinely arrives from where the room's windows are
   * (docs/02 §7). A windowless room falls back to the largest wall, which at
   * least keeps the key stable while walls are edited.
   */
  const keyPosition = useMemo<[number, number, number]>(() => {
    let best: { score: number; pos: [number, number, number] } | null = null;
    const anyGlazing = shell.walls.some((w) => w.windowArea > 0);
    for (const wall of shell.walls) {
      const mx = (wall.start[0] + wall.end[0]) / 2;
      const mz = (wall.start[2] + wall.end[2]) / 2;
      // Outward = away from the room, so the light sits outside shining in.
      const ox = -wall.inwardNormal[0];
      const oz = -wall.inwardNormal[2];
      const score = anyGlazing ? wall.windowArea : wall.length * wall.height;
      if (!best || score > best.score) {
        best = { score, pos: [mx + ox * span * 1.1, wall.height * 1.6, mz + oz * span * 1.1] };
      }
    }
    return best?.pos ?? [cx + span, span, cz + span];
  }, [shell, span, cx, cz]);

  // The bounce sits opposite the key, low and cool — light off the far wall.
  const bouncePosition = useMemo<[number, number, number]>(
    () => [2 * cx - keyPosition[0], shell.height * 0.6, 2 * cz - keyPosition[2]],
    [keyPosition, cx, cz, shell.height],
  );

  return (
    <>
      {/* PCSS soft shadows: contact-hardening penumbra, shader-only (no assets).
          Mounted with the AO tier — the shader patch costs real fragment work. */}
      {quality.ao && <SoftShadows size={18} samples={12} focus={0.6} />}
      <Backdrop radius={Math.max(span * 6, 40)} center={shell.center} />
      {/* Sky/ground hemisphere carries the colour separation a flat ambient
          term destroyed; the small warm ambient keeps corners from going muddy. */}
      <hemisphereLight args={["#cfd8e8", "#8a7a66", 0.4]} />
      <ambientLight intensity={0.08} color="#fff4e6" />
      <directionalLight
        // Remount when the governor changes the shadow resolution — the map
        // texture is allocated once, so a prop-only change would keep the old
        // allocation.
        key={quality.shadowMapSize}
        position={keyPosition}
        intensity={1.7}
        color="#fff1dd"
        castShadow
        shadow-mapSize={[quality.shadowMapSize, quality.shadowMapSize]}
        shadow-bias={-0.0002}
        shadow-normalBias={0.02}
        shadow-camera-near={0.1}
        shadow-camera-far={span * 4}
        shadow-camera-left={-span}
        shadow-camera-right={span}
        shadow-camera-top={span}
        shadow-camera-bottom={-span}
      />
      {/* Cool, shadowless bounce opposite the key — walls facing away from the
          window stop reading as a void. */}
      <directionalLight position={bouncePosition} intensity={0.35} color="#dbe4f0" />
      {/* frames={Infinity} keeps the contact shadow live: the old frames={1}
          baked it once on mount, so dragging furniture left its shadow behind
          at the original spot — the most visible lighting defect in the app. */}
      {quality.ao && (
        <ContactShadows
          position={[cx, 0.002, cz]}
          scale={span * 1.6}
          resolution={512}
          blur={2.6}
          opacity={0.42}
          far={shell.height}
          frames={Infinity}
        />
      )}
    </>
  );
}
