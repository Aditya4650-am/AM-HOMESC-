/**
 * The profile panel draws `Properties.level` — NOT `Properties.LID_Lvl`.
 *
 * Measured on the live device (2026-01): the save carried `LID_Lvl=34` and
 * had NO `Properties.level` at all, and the in-game profile showed Level 1.
 * These cases pin the retarget so a UI edit can never silently drift back to
 * the wrong key, and prove an absent `Properties.level` is created on write
 * while `LID_Lvl` is left alone.
 *
 * Run with:
 *   node --experimental-strip-types --test src/engine/*.test.ts
 */
import { readFileSync } from "node:fs";
import test from "node:test";
import assert from "node:assert/strict";
import { CATALOG } from "./catalog.ts";
import { openSave } from "./savegame.ts";
import { runApply } from "./operations.ts";

const levelField = () => CATALOG.flatMap((g) => g.fields).find((f) => f.label === "Level");

test("the Level field targets Properties.level", () => {
  const field = levelField();
  assert.ok(field, "a field labelled `Level` must exist in the catalog");
  assert.equal(field!.path, "Properties.level");
  // LID_Lvl stays visible as its own, distinctly-labelled field.
  const lid = CATALOG.flatMap((g) => g.fields).find((f) => f.path === "Properties.LID_Lvl");
  assert.ok(lid, "Properties.LID_Lvl is kept as a separate field");
  assert.notEqual(lid!.label, "Level");
});

test("setting Level leaves LID_Lvl and unrelated `level` keys untouched", () => {
  const save = openSave(
    new TextEncoder().encode(
      JSON.stringify({ Properties: { level: 1, LID_Lvl: 42 }, Incomes: { level: 9 } }),
    ),
  );
  save.set(levelField()!.path, 500);
  assert.equal(save.number("Properties.level"), 500);
  assert.equal(save.number("Properties.LID_Lvl"), 42);
  assert.equal(save.number("Incomes.level"), 9);
});

test("runApply creates an absent Properties.level instead of dead-ending", () => {
  const save = openSave(
    new TextEncoder().encode(JSON.stringify({ Properties: { LID_Lvl: 34, coins: 100 } })),
  );
  assert.equal(save.has("Properties.level"), false);

  const plain = new TextEncoder().encode(JSON.stringify({ Properties: { LID_Lvl: 34, coins: 100 } }));
  const res = runApply(plain, [{ path: "Properties.level", value: 34 }]);
  assert.equal(res.ok, true, res.errors.join("; "));
  assert.ok(
    res.warnings.some((w) => w.includes("Properties.level") && w.includes("created")),
    `expected a "created" warning, got: ${res.warnings.join(" | ")}`,
  );

  const out = openSave(res.bytes);
  assert.equal(out.number("Properties.level"), 34);
  assert.equal(out.number("Properties.LID_Lvl"), 34, "LID_Lvl is preserved verbatim");
});

test("every level editor in the UI reads Properties.level", () => {
  for (const name of [
    "../sections/DashboardSection.tsx",
    "../sections/CoreSection.tsx",
    "../components/StudioApp.tsx",
    "../lib/studio.tsx",
  ]) {
    const source = readFileSync(new URL(name, import.meta.url), "utf8");
    assert.ok(source.includes("Properties.level"), `${name} must read Properties.level`);
  }
  // The dashboard tile and the Core KPI are the two EDITORS — they must not
  // stage a write to LID_Lvl (StudioApp/studio.tsx only *read* it as a
  // fallback for saves that predate `Properties.level`).
  for (const name of ["../sections/DashboardSection.tsx", "../sections/CoreSection.tsx"]) {
    const source = readFileSync(new URL(name, import.meta.url), "utf8");
    assert.ok(!source.includes("Properties.LID_Lvl"), `${name} must not edit Properties.LID_Lvl`);
  }
});
