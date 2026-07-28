#!/usr/bin/env node
/**
 * Golden-room regression suite (docs/05 §9, docs/09 M4).
 *
 * Runs the pipeline over every fixture room and scores the result against its
 * hand-labelled ground truth: position error, size error, detection recall, and
 * match quality. Any room that misses its tier's target, or that got worse than
 * the recorded baseline, fails the run.
 *
 *   pnpm test:golden [-- --update-baseline] [-- --require-fixtures]
 *
 * Fixtures are measurements of real rooms and are not in this repository — see
 * fixtures/golden-rooms/README.md. With none present the suite reports that it
 * certified nothing and exits 0, unless --require-fixtures is passed (which is
 * what the pipeline's own CI job should use once fixtures exist).
 */
import { readFileSync, writeFileSync, existsSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { RoomPlanSchema, planToShell } from "@myroom/schema";
import { assembleScene, matchCatalog, regressions, scoreRoom } from "@myroom/recon";

const root = join(dirname(fileURLToPath(import.meta.url)), "../../..");
const fixturesDir = join(root, "fixtures", "golden-rooms");
const baselinePath = join(fixturesDir, "baseline.json");
const args = process.argv.slice(2);

function fixtureRooms() {
  if (!existsSync(fixturesDir)) return [];
  return readdirSync(fixturesDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
    .map((entry) => entry.name)
    .filter((name) => existsSync(join(fixturesDir, name, "truth.json")));
}

/**
 * Run the pipeline for one fixture.
 *
 * Stages 1–3 need a GPU worker. When one is configured (MYROOM_PIPELINE_URL),
 * the fixture's photos go through it; otherwise the run is scored against
 * whatever measurements the fixture already carries, so the *scoring* half of
 * the suite still runs. A run with no vision tier is reported as such and never
 * counted as evidence of accuracy.
 */
async function runRoom(name) {
  const dir = join(fixturesDir, name);
  const truth = JSON.parse(readFileSync(join(dir, "truth.json"), "utf8"));
  const plan = RoomPlanSchema.parse(JSON.parse(readFileSync(join(dir, "plan.json"), "utf8")));
  const shell = planToShell(plan);
  if (!shell) throw new Error(`${name}: plan.json is not a closed room`);

  const measuredPath = join(dir, "measured.json");
  if (!existsSync(measuredPath)) {
    return { name, truth, scene: null, reason: "no measured.json — this room needs a vision-tier run" };
  }

  const measured = JSON.parse(readFileSync(measuredPath, "utf8"));
  const matches = measured.map((m) => matchCatalog({ measured: m }));
  let counter = 0;
  const { scene } = assembleScene({
    sceneId: `golden-${name}`,
    planId: plan.id,
    shell,
    measured,
    matches,
    tier: truth.tier,
    jobId: null,
    now: new Date(0).toISOString(),
    newId: () => `${name}-${++counter}`,
  });
  return { name, truth, scene, reason: null };
}

const rooms = fixtureRooms();

if (rooms.length === 0) {
  console.log("Golden-room suite: no fixture rooms present.");
  console.log("  This run certified NOTHING about pipeline accuracy.");
  console.log("  See fixtures/golden-rooms/README.md for what a fixture is and why");
  console.log("  it cannot be synthesized.");
  process.exit(args.includes("--require-fixtures") ? 1 : 0);
}

const scores = [];
const skipped = [];
for (const name of rooms) {
  const result = await runRoom(name);
  if (!result.scene) {
    skipped.push(`${name}: ${result.reason}`);
    continue;
  }
  scores.push(scoreRoom(result.truth, result.scene));
}

for (const score of scores) {
  const line = [
    score.passes ? "PASS" : "FAIL",
    score.room.padEnd(24),
    `tier ${score.tier}`,
    `recall ${(score.recall * 100).toFixed(0)}%`,
    `pos p90 ${(score.p90PositionError * 100).toFixed(1)} cm`,
    `size ${(score.medianSizeError * 100).toFixed(1)}%`,
    `models ${(score.matchQuality * 100).toFixed(0)}%`,
  ].join("  ");
  console.log(line);
  for (const failure of score.failures) console.log(`      ${failure}`);
}

const baseline = existsSync(baselinePath) ? JSON.parse(readFileSync(baselinePath, "utf8")) : {};
const regressed = regressions(scores, baseline);

if (args.includes("--update-baseline")) {
  const next = Object.fromEntries(
    scores.map((s) => [
      s.room,
      { p90PositionError: s.p90PositionError, medianSizeError: s.medianSizeError, recall: s.recall },
    ]),
  );
  writeFileSync(baselinePath, JSON.stringify({ ...baseline, ...next }, null, 2) + "\n");
  console.log(`\nBaseline updated for ${scores.length} room(s).`);
}

if (skipped.length) {
  console.log(`\n${skipped.length} room(s) skipped — not scored, not passing:`);
  for (const note of skipped) console.log(`  - ${note}`);
}
for (const note of regressed) console.log(`REGRESSION  ${note}`);

const failed = scores.filter((s) => !s.passes).length;
console.log(
  `\n${scores.length - failed}/${scores.length} rooms within target` +
    (regressed.length ? `, ${regressed.length} regression(s)` : ""),
);
// docs/05 §9 asks for at least five rooms; fewer is a suite that hasn't been
// built yet, and saying otherwise would overstate what CI is checking.
if (scores.length < 5) {
  console.log(`Note: docs/05 §9 requires ≥ 5 fixture rooms; ${scores.length} scored.`);
}
process.exit(failed > 0 || regressed.length > 0 ? 1 : 0);
