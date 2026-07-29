import { t } from "../i18n/index.js";

/**
 * The accuracy badge (docs/01 §7, docs/05 §9) — the honesty contract with the
 * user. It names what the room is built from, so nobody mistakes a sketch for a
 * measurement.
 */
export type AccuracyTier = "sketch" | "photo" | "lidar";

export function AccuracyBadge({ tier }: { tier: AccuracyTier }) {
  const label = t(`accuracy.${tier}`);
  const title = t(`accuracy.${tier}.help`);
  return (
    <span className={`accuracy-badge ${tier}`} data-testid="accuracy-badge" title={title}>
      <span className="dot" aria-hidden />
      {label}
    </span>
  );
}
