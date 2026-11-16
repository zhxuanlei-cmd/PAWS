import assert from "node:assert/strict";
import {mkdtempSync, readFileSync, writeFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import test from "node:test";
import {adapterTargets, checkAdapters, syncAdapters} from "../src/adapters.js";
import {resolveVaultDir} from "../src/paths.js";

test("three harness adapters are generated from one source hash and drift is detected", () => {
  const source = join(resolveVaultDir(), "scripts", "skills", "paws-project-continuation");
  const root = mkdtempSync(join(tmpdir(), "paws-adapters-"));
  const targets = adapterTargets(root);
  const synced = syncAdapters(source, targets);
  assert.equal(synced.length, 3);
  assert.ok(synced.every((item) => item.valid));
  assert.equal(new Set(synced.map((item) => item.sourceHash)).size, 1);
  const opencodeSkill = join(targets[0]?.directory ?? "", "paws-project-continuation", "SKILL.md");
  const sourceSkill = readFileSync(join(source, "SKILL.md"), "utf8");
  assert.equal(readFileSync(opencodeSkill, "utf8"), sourceSkill);
  writeFileSync(opencodeSkill, `${sourceSkill}\nlocal drift\n`);
  const checked = checkAdapters(source, targets);
  assert.equal(checked.find((item) => item.harness === "opencode")?.valid, false);
  assert.ok(checked.filter((item) => item.harness !== "opencode").every((item) => item.valid));
});
