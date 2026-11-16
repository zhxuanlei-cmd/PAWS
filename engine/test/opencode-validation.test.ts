import assert from "node:assert/strict";
import {mkdtempSync, readFileSync, statSync, writeFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import test from "node:test";
import {readOpenCodeConfig, summarizeOpenCodeConfig, validateOpenCodeConfig} from "../src/opencode-validation.js";

test("read-only config validation preserves input and accepts declared custom models", () => {
  // 最小宿主目录加自定义模型，验证提取后的校验模块仍能解析原合同。
  const root = mkdtempSync(join(tmpdir(), "paws-validation-"));
  const schema = join(root, "schema.json");
  writeFileSync(schema, JSON.stringify({type: "object"}));
  writeFileSync(join(root, "model-schema.json"), JSON.stringify({$id: "https://models.dev/model-schema.json",
    $defs: {Model: {type: "string", enum: ["native/model"]}}}));
  const path = join(root, "config.json");
  writeFileSync(path, JSON.stringify({lsp: true, model: "demo/custom", default_agent: "writer",
    provider: {demo: {options: {apiKey: "{env:DEMO_API_KEY}"}, models: {custom: {variants: {known: {}}}}}},
    agent: {writer: {mode: "primary", model: "demo/custom", variant: "known"}}}));
  const before = readFileSync(path);
  const mtime = statSync(path).mtimeMs;
  const config = readOpenCodeConfig(path);
  validateOpenCodeConfig(config, schema);
  assert.equal(summarizeOpenCodeConfig(config).model, "demo/custom");
  assert.deepEqual(readFileSync(path), before);
  assert.equal(statSync(path).mtimeMs, mtime);
  assert.throws(() => validateOpenCodeConfig({...config, model: "missing/model"}, schema), /not available/);
  assert.throws(() => validateOpenCodeConfig({...config, agent: {writer: {mode: "subagent"}}}, schema), /primary or all/);
  assert.throws(() => validateOpenCodeConfig({...config,
    agent: {writer: {mode: "primary", model: "demo/custom", variant: "missing"}}}, schema), /unknown custom variant/);
});

test("validation rejects raw credential input, retired plugins and schema violations", () => {
  // 使用合成值而非真实凭据；拒绝分支和正常分支都必须有证据。
  const root = mkdtempSync(join(tmpdir(), "paws-validation-negative-"));
  const schema = join(root, "schema.json");
  writeFileSync(schema, JSON.stringify({type: "object", properties: {lsp: {type: "boolean"}}}));
  validateOpenCodeConfig({lsp: true}, schema);
  assert.throws(() => validateOpenCodeConfig({lsp: true,
    provider: {demo: {options: {apiKey: "synthetic-only"}}}}, schema), /must use an/);
  assert.throws(() => validateOpenCodeConfig({lsp: true, plugin: ["claude-mem"]}, schema), /removed plugin/);
  assert.throws(() => validateOpenCodeConfig({lsp: false}, schema), /must enable LSP/);
  assert.throws(() => validateOpenCodeConfig({lsp: {}}, schema), /schema validation failed/);
});
