/**
 * The license allowlist and SPDX-expression policy (docs/08 §7).
 *
 * Kept separate from the CI runner so the policy itself is unit-testable — a
 * gate that has never been shown to reject anything is not a gate.
 */

export const ALLOWED = new Set([
  "MIT",
  "Apache-2.0",
  "BSD-2-Clause",
  "BSD-3-Clause",
  "ISC",
  "CC0-1.0",
  "PostgreSQL",
  "Python-2.0",
  "Unlicense",
  "0BSD",
  // Common SPDX spellings of the same permissive set.
  "BSD",
  "MIT*",
  "Apache-2.0 WITH LLVM-exception",
  "BlueOak-1.0.0",
]);

/**
 * Documented exemptions, by package name. Each entry must say why the license
 * creates no obligation for us (docs/08 §2, §7).
 *
 * MinIO (AGPL-3.0) is deliberately absent: it is a dev/CI-only standalone
 * service we never link against, and it is not an npm dependency.
 */
export const EXEMPTIONS = new Map();

/**
 * An SPDX expression passes only if it is allowed outright, or — for a
 * disjunction — at least one alternative is allowed, or — for a conjunction —
 * every term is allowed.
 */
export function isAllowed(license) {
  if (license === null || license === undefined) return false;
  const l = String(license).trim();
  if (l === "") return false;
  if (ALLOWED.has(l)) return true;
  const inner = /^\((.*)\)$/.exec(l)?.[1] ?? l;
  if (inner.includes(" OR ")) {
    return inner.split(" OR ").some((part) => isAllowed(part.trim()));
  }
  if (inner.includes(" AND ")) {
    return inner.split(" AND ").every((part) => isAllowed(part.trim()));
  }
  return false;
}
