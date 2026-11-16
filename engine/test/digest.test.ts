import assert from "node:assert/strict";
import {mkdirSync, mkdtempSync, symlinkSync, writeFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import test from "node:test";
import {inputDigest} from "../src/digest.js";
import type {GateSpec} from "../src/types.js";

test("gate digest ignores unrelated symlink trees but rejects a symlink in input scope", () => {
  const repo = mkdtempSync(join(tmpdir(), "paws-digest-"));
  mkdirSync(join(repo, "src"), {recursive: true});
  mkdirSync(join(repo, "node_modules", ".bin"), {recursive: true});
  writeFileSync(join(repo, "src", "input.ts"), "export const value = 1;\n");
  symlinkSync("/usr/bin/env", join(repo, "node_modules", ".bin", "env"));
  const gate: GateSpec = {
    spec_version: 1,
    cwd_relative: ".",
    command_argv: ["node", "--test"],
    input_globs: ["src/**/*.ts"],
    environment_probes: []
  };
  assert.match(inputDigest(repo, gate), /^sha256:[0-9a-f]{64}$/);
  symlinkSync("/usr/bin/env", join(repo, "src", "linked.ts"));
  assert.throws(() => inputDigest(repo, gate), /symlink is not allowed in gate inputs/);
});
