import { en, type MessageKey } from "./en.js";

/**
 * The localization scaffold (docs/09 M6). English is the only catalogue at
 * launch; the point of the scaffold is that adding a second one is a data
 * change, not a code change.
 */

export type Catalog = Record<MessageKey, string>;

const CATALOGS: Record<string, Catalog> = { en };

let active: Catalog = en;
let activeTag = "en";

/**
 * Pick the best catalogue for a set of language tags, falling back to English.
 * Matching is by primary subtag, so `en-GB` and `en-AU` both find `en`.
 */
export function selectLocale(preferred: readonly string[] = navigator?.languages ?? ["en"]): string {
  for (const tag of preferred) {
    const primary = tag.toLowerCase().split("-")[0]!;
    if (CATALOGS[tag.toLowerCase()]) {
      active = CATALOGS[tag.toLowerCase()]!;
      activeTag = tag.toLowerCase();
      return activeTag;
    }
    if (CATALOGS[primary]) {
      active = CATALOGS[primary]!;
      activeTag = primary;
      return activeTag;
    }
  }
  active = en;
  activeTag = "en";
  return activeTag;
}

export const locale = (): string => activeTag;

/**
 * Look up a message, substituting `{named}` parameters.
 *
 * A missing key returns the key itself rather than an empty string: a visible
 * `privacy.title` in the UI is a bug report; a blank heading is a mystery.
 */
export function t(key: MessageKey, params?: Record<string, string | number>): string {
  const template = active[key] ?? en[key] ?? key;
  if (!params) return template;
  return template.replace(/\{(\w+)\}/g, (whole, name: string) =>
    name in params ? String(params[name]) : whole,
  );
}

/** Every key the English catalogue defines — used to check a new catalogue. */
export const MESSAGE_KEYS = Object.keys(en) as MessageKey[];

/** Keys a catalogue is missing relative to English. */
export function missingKeys(catalog: Partial<Catalog>): MessageKey[] {
  return MESSAGE_KEYS.filter((key) => catalog[key] === undefined);
}
