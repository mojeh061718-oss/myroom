import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * docs/02 §9 (ship-blocking): "Contrast ≥ 4.5:1 (text), ≥ 3:1 (essential UI)".
 *
 * The axe audit in `e2e/accessibility.spec.ts` catches this on rendered pages;
 * this catches it in the tokens, where the mistake is actually made, and covers
 * both themes without rendering either.
 */

const css = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "tokens.css"), "utf8");

function themeTokens(selector: string): Record<string, string> {
  const start = css.indexOf(selector);
  const block = css.slice(css.indexOf("{", start) + 1, css.indexOf("}", start));
  const out: Record<string, string> = {};
  for (const line of block.split("\n")) {
    const match = line.match(/(--[a-z-]+):\s*([^;]+);/);
    if (match) out[match[1]!] = match[2]!.trim();
  }
  return out;
}

function relativeLuminance(hex: string): number {
  const channel = (value: number) => {
    const c = value / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

export function contrast(a: string, b: string): number {
  const la = relativeLuminance(a);
  const lb = relativeLuminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

const dark = themeTokens(":root {");
const light = themeTokens(':root[data-theme="light"]');

describe.each([
  ["dark", dark],
  ["light", light],
])("%s theme contrast (docs/02 §9)", (_name, tokens) => {
  it("body text on the background clears 4.5:1", () => {
    expect(contrast(tokens["--text"]!, tokens["--bg"]!)).toBeGreaterThanOrEqual(4.5);
    expect(contrast(tokens["--text"]!, tokens["--surface-solid"]!)).toBeGreaterThanOrEqual(4.5);
  });

  it("dimmed text — captions and metrics — still clears 4.5:1", () => {
    // Dim text is still text. It carries wall lengths and areas.
    expect(contrast(tokens["--text-dim"]!, tokens["--bg"]!)).toBeGreaterThanOrEqual(4.5);
    expect(contrast(tokens["--text-dim"]!, tokens["--surface-solid"]!)).toBeGreaterThanOrEqual(4.5);
  });

  it("white text on filled controls clears 4.5:1", () => {
    // The primary button, the selected segment, the active chip.
    expect(contrast("#FFFFFF", tokens["--accent-strong"]!)).toBeGreaterThanOrEqual(4.5);
    expect(contrast("#FFFFFF", tokens["--danger-strong"]!)).toBeGreaterThanOrEqual(4.5);
  });

  it("accent outlines and state colours clear the 3:1 essential-UI bar", () => {
    for (const token of ["--accent", "--accent-warm", "--success", "--danger"]) {
      expect(contrast(tokens[token]!, tokens["--bg"]!)).toBeGreaterThanOrEqual(3);
    }
  });
});

describe("the contrast maths itself", () => {
  it("agrees with the WCAG reference values", () => {
    expect(contrast("#FFFFFF", "#000000")).toBeCloseTo(21, 5);
    expect(contrast("#FFFFFF", "#FFFFFF")).toBeCloseTo(1, 5);
    // A well-known boundary case: #767676 on white is exactly the 4.5:1 bar.
    expect(contrast("#767676", "#FFFFFF")).toBeGreaterThanOrEqual(4.5);
    expect(contrast("#777777", "#FFFFFF")).toBeLessThan(4.6);
  });
});
