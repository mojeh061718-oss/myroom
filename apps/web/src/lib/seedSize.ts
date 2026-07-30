import { getCategory } from "@myroom/catalog";

/**
 * Reconcile a scan-measured box with what the user (or the photo pass) says
 * it is.
 *
 * A cluttered scan measures a couch too deep — the ottoman in front of it
 * and the blanket over it are welded into the cluster — and a small trash
 * can too short. Once something is NAMED, the name carries information the
 * measurement doesn't: real couches are couch-deep. Each axis keeps the
 * measurement when it is plausible for the category (0.6–1.5× the nominal
 * size — real furniture varies) and takes the category's nominal size when
 * it is not.
 *
 * Width/depth are compared orientation-agnostically: a cluster's axes carry
 * no sense of which way the object faces, so both pairings are tried and
 * the one preserving more of the measurement wins.
 */
export function sizeForNamedSeed(
  measured: { w: number; d: number; h: number },
  categoryId: string,
): { w: number; d: number; h: number } {
  const nominal = getCategory(categoryId)?.defaultSize;
  if (!nominal) return measured;

  const plausible = (m: number, n: number) => m >= n * 0.6 && m <= n * 1.5;
  const snap = (m: number, n: number) => (plausible(m, n) ? m : n);

  const pairings: [number, number][] = [
    [nominal.w, nominal.d],
    [nominal.d, nominal.w],
  ];
  let best: { w: number; d: number } | null = null;
  let bestKept = -1;
  for (const [nw, nd] of pairings) {
    const kept = (plausible(measured.w, nw) ? 1 : 0) + (plausible(measured.d, nd) ? 1 : 0);
    if (kept > bestKept) {
      bestKept = kept;
      best = { w: snap(measured.w, nw), d: snap(measured.d, nd) };
    }
  }
  return { ...best!, h: snap(measured.h, nominal.h) };
}
