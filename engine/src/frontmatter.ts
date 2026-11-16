import { readFileSync } from "node:fs";
import { parseDocument, stringify, visit } from "yaml";
import { PawsError } from "./errors.js";
import type { ParsedMarkdown } from "./types.js";

function parseFailure(path: string, message: string, pointer?: string): PawsError {
  return new PawsError({code: "E_PARSE", path, message, ...(pointer ? {pointer} : {})});
}

export function parseMarkdown(source: string, path = "<memory>"): ParsedMarkdown {
  if (source.charCodeAt(0) === 0xfeff) {
    throw parseFailure(path, "UTF-8 BOM is not allowed before frontmatter");
  }

  const firstNewline = source.indexOf("\n");
  if (firstNewline < 0 || source.slice(0, firstNewline).replace(/\r$/, "") !== "---") {
    throw parseFailure(path, "missing opening frontmatter delimiter");
  }

  const closePattern = /^---[ \t]*\r?$/gm;
  closePattern.lastIndex = firstNewline + 1;
  const close = closePattern.exec(source);
  if (!close) throw parseFailure(path, "missing closing frontmatter delimiter");

  const frontmatterSource = source.slice(firstNewline + 1, close.index);
  let bodyStart = close.index + close[0].length;
  if (source[bodyStart] === "\n") bodyStart += 1;
  const body = source.slice(bodyStart);

  const document = parseDocument(frontmatterSource, {
    schema: "core",
    uniqueKeys: true,
    prettyErrors: false
  });
  if (document.errors.length > 0 || document.warnings.length > 0) {
    const problem = document.errors[0] ?? document.warnings[0];
    throw parseFailure(path, problem?.message ?? "invalid YAML frontmatter");
  }

  let containsAlias = false;
  visit(document, {
    Alias() {
      containsAlias = true;
    }
  });
  if (containsAlias) throw parseFailure(path, "YAML aliases are not allowed");

  let value: unknown;
  try {
    value = document.toJS({maxAliasCount: 0});
  } catch (error) {
    throw parseFailure(path, error instanceof Error ? error.message : "YAML conversion failed");
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw parseFailure(path, "frontmatter must be a mapping object");
  }

  return {
    path,
    source,
    frontmatterSource,
    body,
    data: value as Record<string, unknown>
  };
}

export function parseMarkdownFile(path: string): ParsedMarkdown {
  return parseMarkdown(readFileSync(path, "utf8"), path);
}

export function renderUnchanged(document: ParsedMarkdown): string {
  return document.source;
}

export function renderWithData(document: ParsedMarkdown, data: Record<string, unknown>): string {
  const yaml = stringify(data, {lineWidth: 0}).trimEnd();
  return `---\n${yaml}\n---\n${document.body}`;
}

export function renderNewMarkdown(data: Record<string, unknown>, body: string): string {
  const yaml = stringify(data, {lineWidth: 0}).trimEnd();
  const normalizedBody = body.endsWith("\n") ? body : `${body}\n`;
  return `---\n${yaml}\n---\n\n${normalizedBody}`;
}
