import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import {Ajv2020, type ErrorObject, type ValidateFunction} from "ajv/dist/2020.js";
import type { ParsedMarkdown, StrictObjectType, ValidationIssue } from "./types.js";
import { STRICT_TYPES } from "./types.js";

const schemaFileByType: Record<StrictObjectType, string> = {
  task: "task.schema.json",
  evidence: "evidence.schema.json",
  repository: "repository.schema.json",
  policy: "policy.schema.json"
};

function formatAjvError(path: string, error: ErrorObject): ValidationIssue {
  return {
    code: "E_SCHEMA",
    path,
    pointer: error.instancePath || "/",
    message: `${error.instancePath || "/"} ${error.message ?? "schema validation failed"}`,
    details: {keyword: error.keyword, params: error.params}
  };
}

export class SchemaRegistry {
  readonly schemaDir: string;
  private readonly validators = new Map<StrictObjectType, ValidateFunction>();

  constructor(schemaDir: string) {
    this.schemaDir = schemaDir;
    const ajv = new Ajv2020({
      allErrors: true,
      strict: true,
      allowUnionTypes: true,
      validateFormats: false
    });

    const names = readdirSync(schemaDir)
      .filter((name) => name.endsWith(".schema.json"))
      .sort((left, right) => Buffer.compare(Buffer.from(left), Buffer.from(right)));
    for (const name of names) {
      const schema = JSON.parse(readFileSync(join(schemaDir, name), "utf8")) as object;
      ajv.addSchema(schema);
    }

    for (const type of STRICT_TYPES) {
      const id = `https://paws.local/schema/1.1/${schemaFileByType[type]}`;
      const validator = ajv.getSchema(id);
      if (!validator) throw new Error(`schema did not register: ${id}`);
      this.validators.set(type, validator);
    }
  }

  isStrictType(value: unknown): value is StrictObjectType {
    return typeof value === "string" && (STRICT_TYPES as readonly string[]).includes(value);
  }

  validate(document: ParsedMarkdown): ValidationIssue[] {
    const type = document.data.type;
    if (!this.isStrictType(type)) return [];
    const validator = this.validators.get(type);
    if (!validator) throw new Error(`validator missing for ${type}`);
    if (validator(document.data)) return [];
    return (validator.errors ?? []).map((error) => formatAjvError(document.path, error));
  }
}
