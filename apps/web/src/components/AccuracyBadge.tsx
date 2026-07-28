/**
 * The accuracy badge (docs/01 §7, docs/05 §9) — the honesty contract with the
 * user. It names what the room is built from, so nobody mistakes a sketch for a
 * measurement.
 */
const TIERS = {
  sketch: { label: "Sketch", title: "Walls exactly as you drew them; nothing measured from photos." },
  photo: { label: "Photo-calibrated", title: "Walls exact; object positions within about 15 cm, sizes within 10%." },
  lidar: { label: "LiDAR-verified", title: "Shell within about 2 cm; object positions within 5 cm, sizes within 5%." },
} as const;

export type AccuracyTier = keyof typeof TIERS;

export function AccuracyBadge({ tier }: { tier: AccuracyTier }) {
  const { label, title } = TIERS[tier];
  return (
    <span className={`accuracy-badge ${tier}`} data-testid="accuracy-badge" title={title}>
      <span className="dot" aria-hidden />
      {label}
    </span>
  );
}
