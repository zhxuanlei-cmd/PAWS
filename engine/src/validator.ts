import {readFileSync} from "node:fs";
import {compareIssues, PawsError} from "./errors.js";
import {parseMarkdown} from "./frontmatter.js";
import {validateGraph} from "./graph.js";
import {SchemaRegistry} from "./schema.js";
import type {ParsedMarkdown, ValidationContext, ValidationIssue, ValidationResult} from "./types.js";

export class OntologyValidator {
  readonly schemas: SchemaRegistry;

  constructor(schemaDir: string) {
    this.schemas = new SchemaRegistry(schemaDir);
  }

  validateFiles(paths: string[], context: ValidationContext = {}): ValidationResult {
    const sources = paths.map((path) => ({path, source: readFileSync(path, "utf8")}));
    return this.validateSources(sources, context);
  }

  validateSources(
    sources: Array<{path: string; source: string}>,
    context: ValidationContext = {}
  ): ValidationResult {
    const documents: ParsedMarkdown[] = [];
    const issues: ValidationIssue[] = [];
    for (const input of sources) {
      try {
        documents.push(parseMarkdown(input.source, input.path));
      } catch (error) {
        if (error instanceof PawsError) issues.push(error.toIssue());
        else issues.push({
          code: "E_PARSE",
          path: input.path,
          message: error instanceof Error ? error.message : String(error)
        });
      }
    }
    if (issues.length > 0) return this.result(documents, issues);

    for (const document of documents) issues.push(...this.schemas.validate(document));
    if (issues.length > 0) return this.result(documents, issues);

    issues.push(...validateGraph(documents, context));
    return this.result(documents, issues);
  }

  validateActionRequest(path: string): Record<string, unknown> {
    const source = readFileSync(path, "utf8");
    const document = JSON.parse(source) as Record<string, unknown>;
    return document;
  }

  private result(documents: ParsedMarkdown[], issues: ValidationIssue[]): ValidationResult {
    const sorted = [...issues].sort(compareIssues);
    return {
      valid: sorted.length === 0,
      code: sorted[0]?.code ?? "OK",
      issues: sorted,
      documents
    };
  }
}
