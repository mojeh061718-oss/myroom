/**
 * Design tokens (docs/02). These land 1:1 in CSS custom properties in tokens.css;
 * this module is the typed source for JS consumers (canvas drawing, motion).
 */

export const color = {
  dark: {
    bg: "#0E0F12",
    surface: "rgba(26, 28, 33, 0.8)",
    surfaceSolid: "#1A1C21",
    text: "#F2F3F5",
    textDim: "#9BA0AA",
    accent: "#4C8DFF",
    accentWarm: "#FFB35C",
    success: "#5ECC8F",
    danger: "#FF6B6B",
    canvasGrid: "#26282E",
  },
  light: {
    bg: "#F7F7F9",
    surface: "rgba(255, 255, 255, 0.78)",
    surfaceSolid: "#FFFFFF",
    text: "#17181C",
    textDim: "#6E7480",
    accent: "#2F6FE4",
    accentWarm: "#E8933A",
    success: "#2FA36B",
    danger: "#D64545",
    canvasGrid: "#E4E6EA",
  },
} as const;

export const radius = { sm: 8, md: 12, lg: 16, pill: 28 } as const;

/** docs/02 §5 — screen-transition spring. */
export const spring = { mass: 1, stiffness: 260, damping: 24 } as const;

export const type = {
  displayXl: { size: "2.75rem", weight: 700, tracking: "-0.02em" },
  displayL: { size: "2.125rem", weight: 700, tracking: "-0.015em" },
  title: { size: "1.375rem", weight: 600 },
  body: { size: "1.0625rem", weight: 400, lineHeight: 1.45 },
  label: { size: "0.9375rem", weight: 500 },
  caption: { size: "0.8125rem", weight: 400 },
  metric: { size: "0.9375rem", weight: 500, mono: true },
} as const;

/** Haptics via the Vibration API where available; silently absent elsewhere (docs/02 §5). */
export function haptic(kind: "light" | "medium" | "success" = "light"): void {
  try {
    const pattern = kind === "light" ? [10] : kind === "medium" ? [20] : [10, 40, 20];
    navigator.vibrate?.(pattern);
  } catch {
    // never a feature gate
  }
}

export function prefersReducedMotion(): boolean {
  return typeof matchMedia !== "undefined" && matchMedia("(prefers-reduced-motion: reduce)").matches;
}
