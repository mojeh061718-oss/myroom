import { getCategory } from "./taxonomy.js";
import type { ObjectCategory } from "@myroom/schema";

/**
 * Parametric object geometry (docs/05 §6).
 *
 * The blueprint specifies these as the pipeline's fallback when no catalog
 * model matches — "a clean procedural stand-in (box/cylinder-composed shapes
 * per category)… *Never omit a detected object silently.*" They are also what
 * M3 places from the catalog until the CC0 GLB library is built.
 * See DECISIONS.md → "Parametric catalog before CC0 GLB assets".
 *
 * Parts are expressed in a normalized unit box so one description serves every
 * instance size: x and z run −0.5…0.5, y runs 0…1 (0 = the object's base).
 */

export type PartShape = "box" | "cylinder" | "sphere";

export interface PlaceholderPart {
  shape: PartShape;
  /** which material slot paints this part */
  slot: string;
  /** centre, normalized */
  position: [number, number, number];
  /** extent, as a fraction of the object's size */
  size: [number, number, number];
  /** box corner rounding, 0–0.5 of the smallest extent */
  round?: number;
}

export type Archetype =
  | "seating"
  | "chair"
  | "table"
  | "storage"
  | "bed"
  | "lamp"
  | "pendant"
  | "flat"
  | "rug"
  | "appliance"
  | "plant"
  | "fan"
  | "screen"
  | "stand"
  | "block";

/** Maps a category to the shape family that reads best for it. */
export function archetypeFor(category: ObjectCategory): Archetype {
  const id = category.id;
  const group = category.group;

  if (/^(sofa|sectional|loveseat|armchair|accent-chair|recliner|chaise-lounge|daybed)$/.test(id)) return "seating";
  if (/(chair|stool|bench|ottoman|pouf|beanbag)/.test(id)) return "chair";
  if (/(table|desk|island|nightstand|bar-cart)/.test(id)) return "table";
  if (/^(bed|single-bed|king-bed|bunk-bed|mattress|crib)$/.test(id)) return "bed";
  if (/(lamp|lantern|sconce)/.test(id)) return "lamp";
  // Poles with a base — a coat rack modelled as a cabinet reads badly.
  if (/^(coat-rack|umbrella-stand|guitar-stand|easel|birdcage)$/.test(id)) return "stand";
  if (category.support === "ceiling") return /fan/.test(id) ? "fan" : "pendant";
  if (/fan/.test(id)) return "fan";
  if (/^(rug|runner-rug|play-mat|yoga-mat|pet-bed|floor-cushion)$/.test(id)) return "rug";
  if (/^(tv|monitor|laptop|projector-screen)$/.test(id)) return "screen";
  if (category.faceSlot !== null && category.support === "wall") return "flat";
  if (/(plant)/.test(id)) return "plant";
  if (group === "Kitchen Appliances" || group === "Laundry" || /(refrigerator|freezer|oven|dishwasher|washing|dryer)/.test(id)) {
    return "appliance";
  }
  if (group === "Storage" || /(cabinet|dresser|wardrobe|shelf|bookshelf|console|sideboard|buffet|chest)/.test(id)) {
    return "storage";
  }
  return "block";
}

const box = (
  slot: string,
  position: [number, number, number],
  size: [number, number, number],
  round?: number,
): PlaceholderPart => ({ shape: "box", slot, position, size, ...(round ? { round } : {}) });

const cyl = (
  slot: string,
  position: [number, number, number],
  size: [number, number, number],
): PlaceholderPart => ({ shape: "cylinder", slot, position, size });

/** Four legs inset from the corners, occupying the bottom `h` of the object. */
function legs(slot: string, h: number, inset = 0.12, thickness = 0.07): PlaceholderPart[] {
  const x = 0.5 - inset;
  const z = 0.5 - inset;
  return [
    [-x, -z],
    [x, -z],
    [-x, z],
    [x, z],
  ].map(([lx, lz]) => box(slot, [lx!, h / 2, lz!], [thickness, h, thickness]));
}

function build(category: ObjectCategory): PlaceholderPart[] {
  const slots = category.materialSlots;
  const main = slots[0] ?? "body";
  const accent = slots[1] ?? main;

  switch (archetypeFor(category)) {
    case "seating": {
      const seatTop = 0.52;
      return [
        box(main, [0, seatTop / 2 + 0.1, 0.05], [0.98, seatTop - 0.1, 0.9], 0.08), // seat block
        box(main, [0, 0.55, -0.4], [0.98, 0.7, 0.2], 0.06), // back
        box(main, [-0.44, 0.5, 0.02], [0.12, 0.5, 0.86], 0.05), // arms
        box(main, [0.44, 0.5, 0.02], [0.12, 0.5, 0.86], 0.05),
        ...legs(accent, 0.14, 0.1, 0.06),
      ];
    }
    case "chair":
      return [
        box(main, [0, 0.52, 0], [0.94, 0.16, 0.94], 0.05),
        ...(category.defaultSize.h > 0.6
          ? [box(main, [0, 0.78, -0.4], [0.9, 0.44, 0.14], 0.04)]
          : []),
        ...legs(accent, 0.45, 0.14, 0.06),
      ];
    case "table":
      return [box(main, [0, 0.93, 0], [1, 0.09, 1], 0.02), ...legs(accent, 0.9, 0.08, 0.06)];
    case "bed":
      return [
        box(accent, [0, 0.22, 0], [1, 0.42, 1], 0.02), // base
        box(main, [0, 0.62, 0.03], [0.96, 0.4, 0.94], 0.08), // mattress
        box(main, [-0.24, 0.86, -0.36], [0.4, 0.12, 0.22], 0.06), // pillows
        box(main, [0.24, 0.86, -0.36], [0.4, 0.12, 0.22], 0.06),
      ];
    case "lamp":
      return [
        cyl(accent, [0, 0.02, 0], [0.5, 0.04, 0.5]),
        cyl(accent, [0, 0.4, 0], [0.09, 0.76, 0.09]),
        cyl(main, [0, 0.88, 0], [1, 0.24, 1]),
      ];
    case "pendant":
      return [
        cyl(accent, [0, 0.9, 0], [0.05, 0.2, 0.05]),
        cyl(main, [0, 0.4, 0], [1, 0.8, 1]),
      ];
    case "fan":
      return [
        cyl(accent, [0, 0.5, 0], [0.16, 1, 0.16]),
        box(main, [0.25, 0.35, 0], [0.5, 0.05, 0.16]),
        box(main, [-0.25, 0.35, 0], [0.5, 0.05, 0.16]),
        box(main, [0, 0.35, 0.25], [0.16, 0.05, 0.5]),
        box(main, [0, 0.35, -0.25], [0.16, 0.05, 0.5]),
      ];
    case "flat":
      return [
        box(main, [0, 0.5, 0], [1, 1, 1], 0.01),
        ...(category.faceSlot ? [box(category.faceSlot, [0, 0.5, 0.25], [0.86, 0.86, 0.5])] : []),
      ];
    case "screen":
      return [
        box(main, [0, 0.5, 0], [1, 1, 0.5], 0.01),
        ...(category.faceSlot ? [box(category.faceSlot, [0, 0.5, 0.25], [0.96, 0.94, 0.5])] : []),
      ];
    case "rug":
      return [box(main, [0, 0.5, 0], [1, 1, 1], 0.02)];
    case "appliance":
      return [
        box(main, [0, 0.5, 0], [1, 1, 1], 0.03),
        box(accent, [0, 0.5, 0.45], [0.86, 0.7, 0.1], 0.02), // door / front panel
      ];
    case "storage":
      return [
        box(main, [0, 0.52, 0], [1, 0.96, 1], 0.02),
        box(accent, [-0.25, 0.55, 0.45], [0.44, 0.8, 0.1], 0.01), // fronts
        box(accent, [0.25, 0.55, 0.45], [0.44, 0.8, 0.1], 0.01),
        ...(category.defaultSize.h > 0.9 ? [] : legs(accent, 0.06, 0.1, 0.06)),
      ];
    case "plant":
      return [
        cyl(slots[1] ?? "pot", [0, 0.13, 0], [0.55, 0.26, 0.55]),
        { shape: "sphere", slot: main, position: [0, 0.62, 0], size: [0.95, 0.78, 0.95] },
      ];
    case "stand":
      return [
        cyl(main, [0, 0.015, 0], [0.6, 0.03, 0.6]), // base
        cyl(main, [0, 0.5, 0], [0.1, 1, 0.1]), // pole
        box(main, [0, 0.9, 0], [0.85, 0.04, 0.12]), // arms
        box(main, [0, 0.9, 0], [0.12, 0.04, 0.85]),
      ];
    case "block":
    default:
      return [box(main, [0, 0.5, 0], [1, 1, 1], 0.06)];
  }
}

const cache = new Map<string, PlaceholderPart[]>();

/** Parts for a category id, cached. Unknown ids fall back to a plain block. */
export function placeholderParts(categoryId: string): PlaceholderPart[] {
  const cached = cache.get(categoryId);
  if (cached) return cached;
  const category = getCategory(categoryId);
  const parts = category
    ? build(category)
    : [box("body", [0, 0.5, 0], [1, 1, 1], 0.06)];
  cache.set(categoryId, parts);
  return parts;
}
