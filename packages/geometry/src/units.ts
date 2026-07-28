/**
 * Length parsing & formatting (docs/04 §4).
 * Internal unit is ALWAYS meters (BLUEPRINT §3). Display toggle m ↔ ft/in.
 * Accepted inputs: "3.76", "3.76m", "376cm", "3760mm", "12'4\"", "12ft 4in",
 * "12'", "4\"", "12 ft", "4 in" (case-insensitive, unicode ′ ″ accepted).
 * Rounding for display: cm to 1 decimal (i.e. mm resolution), inches to nearest ¼".
 */

export type DisplayUnit = "m" | "ft";

const METERS_PER_FOOT = 0.3048;
const METERS_PER_INCH = 0.0254;

const NUM = "(\\d+(?:[.,]\\d+)?)";

/** Parse a user-typed length into meters. Returns null when unparseable or non-positive. */
export function parseLength(input: string): number | null {
  const s = input.trim().toLowerCase().replace(/′/g, "'").replace(/″/g, '"').replace(/”/g, '"').replace(/’/g, "'");
  if (s.length === 0) return null;

  const num = (t: string): number => parseFloat(t.replace(",", "."));

  // feet + inches: 12'4", 12' 4.5", 12ft 4in, 12 ft, 4 in, 12', 4"
  const ftIn = new RegExp(`^${NUM}\\s*(?:'|ft|feet|foot)(?:\\s*${NUM}\\s*(?:"|in|inch|inches)?)?$`).exec(s);
  if (ftIn && ftIn[1] !== undefined) {
    const feet = num(ftIn[1]);
    const inches = ftIn[2] !== undefined ? num(ftIn[2]) : 0;
    const m = feet * METERS_PER_FOOT + inches * METERS_PER_INCH;
    return m > 0 ? m : null;
  }
  const inOnly = new RegExp(`^${NUM}\\s*(?:"|in|inch|inches)$`).exec(s);
  if (inOnly && inOnly[1] !== undefined) {
    const m = num(inOnly[1]) * METERS_PER_INCH;
    return m > 0 ? m : null;
  }

  const metric = new RegExp(`^${NUM}\\s*(m|cm|mm|meter|meters|metre|metres)?$`).exec(s);
  if (metric && metric[1] !== undefined) {
    const value = num(metric[1]);
    const unit = metric[2] ?? "m";
    const factor = unit === "cm" ? 0.01 : unit === "mm" ? 0.001 : 1;
    const m = value * factor;
    return m > 0 ? m : null;
  }
  return null;
}

/** Round meters to display precision: metric → 1 mm; imperial → nearest ¼ inch. */
export function roundForDisplay(meters: number, unit: DisplayUnit): number {
  if (unit === "m") return Math.round(meters * 1000) / 1000;
  const quarterInches = Math.round(meters / (METERS_PER_INCH / 4));
  return quarterInches * (METERS_PER_INCH / 4);
}

/** Format meters for display. Metric: "6.20 m" (mm shown only when non-zero → "6.204 m"). */
export function formatLength(meters: number, unit: DisplayUnit): string {
  if (unit === "m") {
    const mm = Math.round(meters * 1000);
    const fixed = mm % 10 === 0 ? (mm / 1000).toFixed(2) : (mm / 1000).toFixed(3);
    return `${fixed} m`;
  }
  const quarters = Math.round(meters / (METERS_PER_INCH / 4));
  let feet = Math.floor(quarters / (12 * 4));
  let remQuarters = quarters - feet * 12 * 4;
  let inchesWhole = Math.floor(remQuarters / 4);
  const frac = remQuarters - inchesWhole * 4;
  if (inchesWhole === 12) {
    feet += 1;
    inchesWhole = 0;
  }
  const fracStr = frac === 0 ? "" : frac === 1 ? "¼" : frac === 2 ? "½" : "¾";
  if (feet === 0) return `${inchesWhole}${fracStr}"`;
  if (inchesWhole === 0 && fracStr === "") return `${feet}'`;
  return `${feet}'${inchesWhole}${fracStr}"`;
}

/** Format square meters for the validation badge: "29.8 m²" or "321 ft²" (docs/04 §5). */
export function formatArea(m2: number, unit: DisplayUnit): string {
  if (unit === "m") return `${(Math.round(m2 * 10) / 10).toFixed(1)} m²`;
  const ft2 = m2 / (METERS_PER_FOOT * METERS_PER_FOOT);
  return `${Math.round(ft2)} ft²`;
}

/** Parse the unicode fraction forms formatLength produces, so round-trips hold. */
export function parseDisplayLength(input: string): number | null {
  const s = input.trim().replace(/¼/g, ".25").replace(/½/g, ".5").replace(/¾/g, ".75");
  return parseLength(s);
}
