import assert from "node:assert/strict";
import {join} from "node:path";
import test from "node:test";
import {SchemaRegistry} from "../src/schema.js";
import {resolveVaultDir, schemaDir} from "../src/paths.js";
import {parseMarkdown} from "../src/frontmatter.js";

test("all strict schemas register under version 1.1", () => {
  const vault = resolveVaultDir();
  const registry = new SchemaRegistry(schemaDir(vault));
  for (const type of ["task", "evidence", "repository", "policy"]) {
    assert.equal(registry.isStrictType(type), true);
  }
  assert.equal(registry.isStrictType("experiment"), false);
  assert.equal(join(vault, "ontology", "schema", "1.1"), registry.schemaDir);
});

test("schema rejects an otherwise parseable incomplete strict object", () => {
  const registry = new SchemaRegistry(schemaDir(resolveVaultDir()));
  const document = parseMarkdown([
    "---",
    "schema_version: \"1.1\"",
    "type: task",
    "project: fixture-project",
    "status: active",
    "created: 2026-08-04",
    "updated: 2026-08-04",
    "source: test",
    "draft: true",
    "---",
    ""
  ].join("\n"));
  const issues = registry.validate(document);
  assert(issues.length > 0);
  assert(issues.every((issue) => issue.code === "E_SCHEMA"));
});
