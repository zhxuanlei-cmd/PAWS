import {existsSync, readdirSync, readFileSync} from "node:fs";
import {join, resolve} from "node:path";
import {fileURLToPath} from "node:url";

/** 从显式参数、环境变量或发布目录中定位 Vault，避免读取用户已有的个人 Vault。 */
export function resolveVaultDir(explicit?: string): string {
  const candidate = explicit ?? process.env.VAULT_DIR ?? fileURLToPath(new URL("../../../vault/", import.meta.url));
  const absolute = resolve(candidate);
  if (!existsSync(join(absolute, "AGENTS.md")) || !existsSync(join(absolute, "10-projects"))) {
    throw new Error(`not a PAWS vault: ${absolute}`);
  }
  return absolute;
}

export function schemaDir(vaultDir: string, version = "1.1"): string {
  return join(vaultDir, "ontology", "schema", version);
}

export function walkMarkdown(root: string): string[] {
  const output: string[] = [];
  const walk = (directory: string): void => {
    const entries = readdirSync(directory, {withFileTypes: true})
      .sort((left, right) => Buffer.compare(Buffer.from(left.name), Buffer.from(right.name)));
    for (const entry of entries) {
      if ([".git", ".index", "node_modules"].includes(entry.name)) continue;
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        if (path.includes(`${join("ontology", "fixtures")}`)) continue;
        walk(path);
      } else if (entry.isFile() && entry.name.endsWith(".md")) {
        const firstLine = readFileSync(path, "utf8").split(/\r?\n/, 1)[0];
        if (firstLine === "---") output.push(path);
      }
    }
  };
  walk(root);
  return output;
}
