/**
 * Generates JSON Schema files for the Python vision workers (docs/03 §2:
 * "Python workers validate against the generated JSON Schema files").
 * Output: packages/schema/json/*.schema.json — regenerate whenever schemas change:
 *   pnpm --filter @myroom/schema generate:jsonschema
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { zodToJsonSchema } from "zod-to-json-schema";
import { RoomPlanSchema } from "../src/roomplan.js";
import { SceneSchema, CatalogItemSchema, PlacedObjectSchema, ObjectCategorySchema } from "../src/scene.js";
import { ProjectSchema, UploadSchema, VersionSchema } from "../src/records.js";

const outDir = join(dirname(fileURLToPath(import.meta.url)), "..", "json");
mkdirSync(outDir, { recursive: true });

const entries = {
  "room-plan": RoomPlanSchema,
  scene: SceneSchema,
  "placed-object": PlacedObjectSchema,
  "catalog-item": CatalogItemSchema,
  "object-category": ObjectCategorySchema,
  project: ProjectSchema,
  version: VersionSchema,
  upload: UploadSchema,
} as const;

for (const [name, schema] of Object.entries(entries)) {
  const json = zodToJsonSchema(schema, { name, $refStrategy: "none" });
  writeFileSync(join(outDir, `${name}.schema.json`), JSON.stringify(json, null, 2) + "\n");
  console.log(`wrote json/${name}.schema.json`);
}
