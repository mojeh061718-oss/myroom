import { useEffect, useMemo, useRef, useState } from "react";
import * as THREE from "three";
import { useFrame, useThree } from "@react-three/fiber";
import { OrbitControls, OrthographicCamera, PerspectiveCamera } from "@react-three/drei";
import type { ShellGeometry } from "@myroom/geometry";
import { prefersReducedMotion } from "../../theme/tokens.js";

export type ViewMode = "dollhouse" | "inside" | "plan";

const DEG = Math.PI / 180;

/** 35 mm-equivalent horizontal field of view (docs/02 §7). */
const H_FOV_35MM = 54.4 * DEG;

/**
 * three's `fov` is vertical, so a fixed 38° turns into a ~19° horizontal view
 * on a portrait phone — a telephoto that makes a doorway 3 m away fill the
 * screen. Derive the vertical FOV from the 35 mm-equivalent *horizontal* one
 * instead, clamped so extreme aspect ratios don't distort the perspective.
 */
export function fovFor(aspect: number): number {
  const a = Math.max(aspect, 0.3);
  const vertical = 2 * Math.atan(Math.tan(H_FOV_35MM / 2) / a);
  return Math.min(Math.max(vertical / DEG, 38), 60);
}
const TRANSITION_MS = 650;
const REVEAL_MS = 1500;

const easeInOutCubic = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);

interface Pose {
  position: THREE.Vector3;
  target: THREE.Vector3;
}

/**
 * Distance that fits the room's bounding sphere in the narrower of the two
 * field-of-view axes. Portrait phones are horizontally constrained, so fitting
 * only the vertical FOV crops the room off both sides.
 */
function framingDistance(shell: ShellGeometry, aspect: number): number {
  const w = shell.bounds.max[0] - shell.bounds.min[0];
  const d = shell.bounds.max[2] - shell.bounds.min[2];
  const radius = Math.hypot(w, d, shell.height) / 2;
  const vFov = fovFor(aspect) * DEG;
  const hFov = 2 * Math.atan(Math.tan(vFov / 2) * Math.max(aspect, 0.35));
  const halfMin = Math.min(vFov, hFov) / 2;
  // 0.95 lets the extreme corners sit just off-frame for a fuller composition.
  return (radius / Math.sin(halfMin)) * 0.95;
}

export function poseFor(view: ViewMode, shell: ShellGeometry, aspect: number, azimuth: number): Pose {
  const [cx, , cz] = shell.center;
  if (view === "inside") {
    // Stand just inside the longest wall at eye height and look across the room
    // (docs/06 §2). Orbiting a point a metre away would frame a corner instead.
    const eye = Math.min(1.6, shell.height * 0.7);
    // Stand against the wall with the most openings, so windows and doors are
    // behind the camera and the shot looks across the room at a clean wall —
    // the way interiors are actually photographed. Ties break on wall length.
    const longest = [...shell.walls].sort(
      (a, b) => b.openingCount - a.openingCount || b.length - a.length,
    )[0]!;
    const mx = (longest.start[0] + longest.end[0]) / 2;
    const mz = (longest.start[2] + longest.end[2]) / 2;
    const standOff = 0.7;
    const base = new THREE.Vector3(
      mx + longest.inwardNormal[0] * standOff,
      eye,
      mz + longest.inwardNormal[2] * standOff,
    );
    const target = new THREE.Vector3(cx, eye * 0.85, cz);
    // Let the orbit azimuth swing the standing point around the room centre.
    const radius = Math.max(0.8, base.distanceTo(new THREE.Vector3(cx, eye, cz)));
    const baseAz = Math.atan2(base.x - cx, base.z - cz);
    const az = azimuth === 0 ? baseAz : azimuth;
    return {
      position: new THREE.Vector3(cx + Math.sin(az) * radius, eye, cz + Math.cos(az) * radius),
      target,
    };
  }
  // Dollhouse: gentle elevation, framed on the room centre.
  const dist = framingDistance(shell, aspect);
  const elev = 38 * DEG;
  return {
    position: new THREE.Vector3(
      cx + Math.sin(azimuth) * Math.cos(elev) * dist,
      shell.height / 2 + Math.sin(elev) * dist,
      cz + Math.cos(azimuth) * Math.cos(elev) * dist,
    ),
    target: new THREE.Vector3(cx, shell.height * 0.35, cz),
  };
}

interface Props {
  shell: ShellGeometry;
  view: ViewMode;
  /** fired once the establishing orbit has handed control to the user */
  onRevealed?: () => void;
}

export function CameraRig({ shell, view, onRevealed }: Props) {
  const controls = useRef<any>(null);
  const size = useThree((s) => s.size);
  const aspect = size.width / Math.max(size.height, 1);

  const reduced = useMemo(() => prefersReducedMotion(), []);
  const [revealing, setRevealing] = useState(!reduced);
  const anim = useRef<{ from: Pose; to: Pose; start: number; ms: number } | null>(null);
  const revealStart = useRef<number | null>(null);
  const current = useRef<Pose>(poseFor("dollhouse", shell, aspect, reduced ? 0.9 : 0.35));
  const lastView = useRef<ViewMode>(view);

  const planFrame = useMemo(() => {
    const w = shell.bounds.max[0] - shell.bounds.min[0];
    const d = shell.bounds.max[2] - shell.bounds.min[2];
    return { w, d, zoom: 0 };
  }, [shell]);

  // Animate between camera presets (docs/06 §2: smooth animated transitions).
  useEffect(() => {
    if (view === lastView.current) return;
    lastView.current = view;
    if (view === "plan") return; // orthographic camera takes over
    // Entering Inside uses the wall-derived standing point (azimuth 0);
    // returning to Dollhouse keeps whatever azimuth the user left off at.
    const azimuth =
      view === "inside"
        ? 0
        : Math.atan2(
            current.current.position.x - shell.center[0],
            current.current.position.z - shell.center[2],
          );
    anim.current = {
      from: {
        position: current.current.position.clone(),
        target: current.current.target.clone(),
      },
      to: poseFor(view, shell, aspect, azimuth),
      start: performance.now(),
      ms: reduced ? 1 : TRANSITION_MS,
    };
  }, [view, shell, aspect, reduced]);

  useFrame(({ camera }) => {
    if (view === "plan") return;
    const now = performance.now();

    // Establishing orbit on first reveal (docs/01 §9): 1.5 s, then hand over.
    if (revealing) {
      revealStart.current ??= now;
      const t = Math.min(1, (now - revealStart.current) / REVEAL_MS);
      const azimuth = 0.35 + easeInOutCubic(t) * 0.55;
      current.current = poseFor("dollhouse", shell, aspect, azimuth);
      if (t >= 1) {
        setRevealing(false);
        onRevealed?.();
      }
    } else if (anim.current) {
      const a = anim.current;
      const t = Math.min(1, (now - a.start) / a.ms);
      const e = easeInOutCubic(t);
      current.current = {
        position: a.from.position.clone().lerp(a.to.position, e),
        target: a.from.target.clone().lerp(a.to.target, e),
      };
      if (t >= 1) anim.current = null;
    } else {
      // User is driving; track the live camera so transitions start from here.
      current.current.position.copy(camera.position);
      if (controls.current) current.current.target.copy(controls.current.target);
      return;
    }

    camera.position.copy(current.current.position);
    if (controls.current) {
      controls.current.target.copy(current.current.target);
      controls.current.update();
    } else {
      camera.lookAt(current.current.target);
    }
  });

  const locked = revealing || anim.current !== null;
  const isPlan = view === "plan";

  // Keep the 2D camera aimed at the room whenever it takes over.
  useEffect(() => {
    if (isPlan && controls.current) {
      controls.current.target.set(shell.center[0], 0, shell.center[2]);
      controls.current.update();
    }
  }, [isPlan, shell]);

  const half = useMemo(() => {
    const margin = 1.15;
    return Math.max((planFrame.w * margin) / 2 / Math.max(aspect, 0.35), (planFrame.d * margin) / 2);
  }, [planFrame, aspect]);

  /**
   * BOTH cameras stay mounted; only `makeDefault` moves between them.
   * Unmounting the active camera to swap projections leaves the controls
   * holding an undefined camera for a frame, which throws.
   */
  return (
    <>
      <PerspectiveCamera
        makeDefault={!isPlan}
        fov={fovFor(aspect)}
        near={0.05}
        far={400}
        position={[current.current.position.x, current.current.position.y, current.current.position.z]}
      />
      <OrthographicCamera
        makeDefault={isPlan}
        position={[shell.center[0], shell.height * 4 + 6, shell.center[2]]}
        zoom={1}
        near={0.1}
        far={shell.height * 8 + 40}
        top={half}
        bottom={-half}
        left={-half * aspect}
        right={half * aspect}
        rotation={[-Math.PI / 2, 0, 0]}
      />
      <OrbitControls
        ref={controls}
        makeDefault
        enabled={isPlan || !locked}
        enableDamping={!isPlan}
        dampingFactor={0.08}
        // 2D is a plan view: pan and zoom, never rotate (docs/06 §2).
        enableRotate={!isPlan}
        target={[current.current.target.x, current.current.target.y, current.current.target.z]}
        // Gentle pitch limits so the camera never rolls under the floor
        // or snaps to a dead-overhead view (docs/06 §2).
        minPolarAngle={5 * DEG}
        maxPolarAngle={80 * DEG}
        minDistance={0.4}
        maxDistance={Math.max(12, framingDistance(shell, aspect) * 2.2)}
      />
    </>
  );
}
