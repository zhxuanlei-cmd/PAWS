import assert from "node:assert/strict";
import {readFileSync, readdirSync} from "node:fs";
import {join} from "node:path";
import test from "node:test";
import {PawsError} from "../src/errors.js";
import {parseMarkdown, parseMarkdownFile, renderUnchanged, renderWithData} from "../src/frontmatter.js";
import {resolveVaultDir} from "../src/paths.js";

function walkInputs(root: string): string[] {
  const output: string[] = [];
  for (const entry of readdirSync(root, {withFileTypes: true})) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) output.push(...walkInputs(path));
    if (entry.isFile() && entry.name.endsWith(".md.in")) output.push(path);
  }
  return output.sort((left, right) => Buffer.compare(Buffer.from(left), Buffer.from(right)));
}

test("parser preserves every G0 Markdown fixture byte-for-byte when untouched", () => {
  const root = join(resolveVaultDir(), "ontology", "fixtures");
  const paths = walkInputs(root);
  assert(paths.length > 0);
  for (const path of paths) {
    const source = readFileSync(path, "utf8");
    const parsed = parseMarkdownFile(path);
    assert.equal(renderUnchanged(parsed), source, path);
  }
});

test("parser rejects duplicate keys, aliases, custom tags and missing delimiters", () => {
  const invalid = [
    "---\ntype: task\ntype: evidence\n---\n",
    "---\na: &anchor value\nb: *anchor\n---\n",
    "---\na: !unsafe value\n---\n",
    "type: task\n"
  ];
  for (const [index, source] of invalid.entries()) {
    assert.throws(
      () => parseMarkdown(source, `invalid-${index}`),
      (error: unknown) => error instanceof PawsError && error.code === "E_PARSE"
    );
  }
});

test("frontmatter updates retain the original body", () => {
  const source = "---\ntype: task\nstatus: active\n---\n\n# 标题\n正文\n";
  const parsed = parseMarkdown(source);
  const changed = {...parsed.data, status: "paused"};
  const output = renderWithData(parsed, changed);
  assert(output.endsWith("\n# 标题\n正文\n"));
  assert.match(output, /^---\n/);
  assert.match(output, /status: paused/);
});
