import { useRef } from "react";
import { useFrame, useThree } from "@react-three/fiber";
import {
  initialGovernorState,
  levelFor,
  stepQuality,
  type QualityLevel,
  type QualityPreference,
} from "./quality.js";

/**
 * Applies the docs/06 §8 quality policy to the live renderer.
 *
 * Lives inside the Canvas so it can sample real frame times. The decision
 * itself is in `quality.ts`, which is pure and tested; this component only
 * measures and applies.
 */
export function QualityGovernor({
  preference,
  onChange,
}: {
  preference: QualityPreference;
  onChange?: (level: QualityLevel) => void;
}) {
  const gl = useThree((s) => s.gl);
  const state = useRef(initialGovernorState());
  const applied = useRef<QualityLevel | null>(null);
  const frames = useRef(0);
  const since = useRef(0);

  useFrame((_, delta) => {
    frames.current += 1;
    since.current += delta;
    // One-second samples: short enough to react, long enough not to chase a
    // single slow frame from a texture upload.
    if (since.current >= 1) {
      const fps = frames.current / since.current;
      frames.current = 0;
      since.current = 0;
      if (preference === "auto") state.current = stepQuality(state.current, fps);
    }

    const level = levelFor(preference, state.current.level);
    if (applied.current?.name === level.name) return;
    applied.current = level;

    gl.setPixelRatio(Math.min(window.devicePixelRatio, level.pixelRatio));
    gl.shadowMap.enabled = level.shadowMapSize > 0;
    gl.shadowMap.needsUpdate = true;
    onChange?.(level);
  });

  return null;
}
