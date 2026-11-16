import {existsSync, readdirSync} from "node:fs";
import {join, resolve} from "node:path";
import {PawsError} from "./errors.js";
import {parseMarkdownFile} from "./frontmatter.js";
import type {ParsedMarkdown} from "./types.js";

function utf8Sort(values: string[]): string[] {
  return values.sort((left, right) => Buffer.compare(Buffer.from(left), Buffer.from(right)));
}

/** 提供 Context Pack 所需的项目任务、策略和证据只读视图。 */
export class ProjectStore {
  readonly projectId: string;
  readonly projectDir: string;

  constructor(vaultRoot: string, projectId: string) {
    if (!/^[a-z0-9][a-z0-9-]{0,62}$/.test(projectId)) {
      throw new PawsError({code: "E_ACTION_PRECONDITION", path: projectId, message: "invalid project id"});
    }
    this.projectId = projectId;
    this.projectDir = resolve(vaultRoot, "10-projects", projectId);
    if (!existsSync(this.projectDir)) {
      throw new PawsError({code: "E_ACTION_PRECONDITION", path: this.projectDir, message: "project does not exist"});
    }
  }

  policyPath(): string {
    return join(this.projectDir, "execution-policy.md");
  }

  taskPath(taskId: string): string {
    this.assertId(taskId, /^[A-Z0-9]{2,12}-[0-9]{8}-[0-9]{3}$/);
    return join(this.projectDir, "work-items", `${taskId}.md`);
  }

  evidenceDocuments(): ParsedMarkdown[] {
    const directory = join(this.projectDir, "evidence");
    if (!existsSync(directory)) return [];
    return utf8Sort(readdirSync(directory, {withFileTypes: true})
      .filter((entry) => entry.isFile() && entry.name.endsWith(".md"))
      .map((entry) => join(directory, entry.name)))
      .map((path) => parseMarkdownFile(path));
  }

  readTask(taskId: string): ParsedMarkdown {
    const path = this.taskPath(taskId);
    if (!existsSync(path)) throw this.error("E_ACTION_PRECONDITION", `task not found: ${taskId}`, path);
    const document = parseMarkdownFile(path);
    if (document.data.task_id !== taskId || document.data.project !== this.projectId) {
      throw this.error("E_ACTION_PRECONDITION", `task identity mismatch: ${taskId}`, path);
    }
    return document;
  }

  readPolicy(): ParsedMarkdown {
    const path = this.policyPath();
    if (!existsSync(path)) throw this.error("E_ACTION_PRECONDITION", "execution policy is missing", path);
    return parseMarkdownFile(path);
  }

  migrationMode(): string {
    const policy = this.readPolicy();
    return typeof policy.data.migration_mode === "string" ? policy.data.migration_mode : "legacy";
  }

  private assertId(value: string, pattern: RegExp): void {
    if (!pattern.test(value)) throw this.error("E_ACTION_PRECONDITION", `invalid object id: ${value}`, value);
  }

  private error(code: string, message: string, path: string): PawsError {
    return new PawsError({code, message, path});
  }
}
