/**
 * Schema migrations (docs/07 §8): every `schemaVersion` bump ships a forward
 * migration here. The client migrates local documents on load; the API migrates
 * on read and writes back current. No document is ever unreadable by a newer app.
 *
 * Current version: 1 (initial) — no migrations yet. The registry establishes the
 * mechanism so version 2 has a place to land.
 */

export const CURRENT_SCHEMA_VERSION = 1;

type Migration = (doc: Record<string, unknown>) => Record<string, unknown>;

/** Keyed by the version the migration upgrades FROM (e.g. 1 → migrates v1 to v2). */
const migrations: Record<number, Migration> = {};

export function migrateDocument(doc: Record<string, unknown>): Record<string, unknown> {
  let current = doc;
  let version = typeof current.schemaVersion === "number" ? current.schemaVersion : 1;
  while (version < CURRENT_SCHEMA_VERSION) {
    const step = migrations[version];
    if (!step) {
      throw new Error(`no migration registered from schemaVersion ${version}`);
    }
    current = step(current);
    version = typeof current.schemaVersion === "number" ? current.schemaVersion : version + 1;
  }
  return current;
}
