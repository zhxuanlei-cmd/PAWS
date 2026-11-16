import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {dirname, join} from "node:path";
import test from "node:test";
import {parseDocument} from "yaml";
import {ERROR_PRECEDENCE} from "../src/errors.js";
import {resolveVaultDir, schemaDir} from "../src/paths.js";
import type {ActionRequest, ValidationContext} from "../src/types.js";
import {OntologyValidator} from "../src/validator.js";

function yamlMapping(path: string): Record<string, unknown> {
  const document = parseDocument(readFileSync(path, "utf8"), {
    schema: "core",
    uniqueKeys: true,
    prettyErrors: false
  });
  assert.equal(document.errors.length, 0, `YAML errors in ${path}`);
  assert.equal(document.warnings.length, 0, `YAML warnings in ${path}`);
  const value = document.toJS({maxAliasCount: 0});
  assert(value && typeof value === "object" && !Array.isArray(value));
  return value as Record<string, unknown>;
}

test("G0 fixture manifest is implemented as an independent G1 black-box gate", () => {
  const vault = resolveVaultDir();
  const manifestPath = join(vault, "ontology", "fixtures", "manifest.yaml");
  const fixtureRoot = dirname(manifestPath);
  const manifest = yamlMapping(manifestPath);
  const manifestPrecedence = manifest.error_precedence as string[];
  assert.deepEqual(
    manifestPrecedence,
    ERROR_PRECEDENCE.filter((code) => manifestPrecedence.includes(code)),
    "G1 must preserve G0 error precedence"
  );

  const validator = new OntologyValidator(schemaDir(vault, String(manifest.schema_version)));
  const shared = (manifest.shared_objects as string[]).map((path) => join(fixtureRoot, path));
  const cases = manifest.cases as Array<Record<string, unknown>>;
  assert.equal(cases.filter((fixtureCase) => fixtureCase.kind === "positive").length, 4);
  assert.equal(cases.filter((fixtureCase) => fixtureCase.kind === "negative").length, 8);

  for (const fixtureCase of cases) {
    const expected = fixtureCase.expected as {valid: boolean; code: string};
    const paths = [...shared, ...(fixtureCase.objects as string[]).map((path) => join(fixtureRoot, path))];
    const context: ValidationContext = {fixedNow: String(manifest.fixed_now)};
    if (fixtureCase.repo_root) context.repoRoot = join(fixtureRoot, String(fixtureCase.repo_root));
    if (fixtureCase.environment_probe_results) {
      context.environmentProbeResults = fixtureCase.environment_probe_results as Record<string, string>;
    }
    if (fixtureCase.action_request) {
      context.actionRequest = yamlMapping(join(fixtureRoot, String(fixtureCase.action_request))) as unknown as ActionRequest;
    }
    const result = validator.validateFiles(paths, context);
    assert.equal(result.valid, expected.valid, `${String(fixtureCase.id)} validity`);
    assert.equal(result.code, expected.code, `${String(fixtureCase.id)} code`);
  }
});
