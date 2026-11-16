import {
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  writeFileSync
} from "node:fs";
import {homedir} from "node:os";
import {basename, dirname, join, resolve} from "node:path";
import {digestJson, sha256Bytes} from "./digest.js";
import {assertNoLikelySecret} from "./security.js";

export interface AdapterTarget {
  harness: "opencode" | "codex" | "claude-code";
  directory: string;
}

export interface AdapterStatus {
  harness: AdapterTarget["harness"];
  directory: string;
  valid: boolean;
  reason: string;
  sourceHash: string;
}

interface AdapterSource {
  name: string;
  skill: string;
  openai: string | null;
  sourceHash: string;
  sourceDir: string;
}

interface AdapterMetadata {
  formatVersion: 1;
  generated: true;
  sourceDir: string;
  sourceHash: string;
  skillHash: string;
  openaiHash: string | null;
}

function writeAtomic(path: string, content: string, mode: number): void {
  mkdirSync(dirname(path), {recursive: true, mode: 0o700});
  const temporary = join(dirname(path), `.${basename(path)}.${process.pid}.tmp`);
  const descriptor = openSync(temporary, "wx", mode);
  try {
    writeFileSync(descriptor, content);
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
  renameSync(temporary, path);
  chmodSync(path, mode);
}

function readSource(sourceDirInput: string): AdapterSource {
  const sourceDir = resolve(sourceDirInput);
  const skillPath = join(sourceDir, "SKILL.md");
  if (!existsSync(skillPath)) throw new Error(`SKILL.md is missing: ${skillPath}`);
  const skill = readFileSync(skillPath, "utf8");
  assertNoLikelySecret(skill, skillPath);
  const name = skill.match(/^---\n[\s\S]*?^name:\s*([a-z0-9-]+)\s*$/m)?.[1];
  if (!name) throw new Error(`skill name is missing or invalid: ${skillPath}`);
  const openaiPath = join(sourceDir, "agents", "openai.yaml");
  const openai = existsSync(openaiPath) ? readFileSync(openaiPath, "utf8") : null;
  if (openai) assertNoLikelySecret(openai, openaiPath);
  return {name, skill, openai, sourceHash: digestJson([skill, openai]), sourceDir};
}

export function adapterTargets(testRoot?: string): AdapterTarget[] {
  if (testRoot) {
    const root = resolve(testRoot);
    return [
      {harness: "opencode", directory: join(root, "opencode", "skills")},
      {harness: "codex", directory: join(root, "codex", "skills")},
      {harness: "claude-code", directory: join(root, "claude", "skills")}
    ];
  }
  return [
    {harness: "opencode", directory: join(homedir(), ".config", "opencode", "skills")},
    {harness: "codex", directory: join(homedir(), ".agents", "skills")},
    {harness: "claude-code", directory: join(homedir(), ".claude", "skills")}
  ];
}

export function syncAdapters(sourceDir: string, targets = adapterTargets()): AdapterStatus[] {
  const source = readSource(sourceDir);
  const metadata: AdapterMetadata = {
    formatVersion: 1,
    generated: true,
    sourceDir: source.sourceDir,
    sourceHash: source.sourceHash,
    skillHash: sha256Bytes(source.skill),
    openaiHash: source.openai ? sha256Bytes(source.openai) : null
  };
  for (const target of targets) {
    const directory = join(target.directory, source.name);
    writeAtomic(join(directory, "SKILL.md"), source.skill, 0o644);
    if (source.openai) writeAtomic(join(directory, "agents", "openai.yaml"), source.openai, 0o644);
    writeAtomic(join(directory, ".paws-adapter.json"), `${JSON.stringify(metadata, null, 2)}\n`, 0o600);
  }
  return checkAdapters(sourceDir, targets);
}

export function checkAdapters(sourceDir: string, targets = adapterTargets()): AdapterStatus[] {
  const source = readSource(sourceDir);
  return targets.map((target) => {
    const directory = join(target.directory, source.name);
    const skillPath = join(directory, "SKILL.md");
    const metadataPath = join(directory, ".paws-adapter.json");
    if (!existsSync(skillPath) || !existsSync(metadataPath)) {
      return {harness: target.harness, directory, valid: false, reason: "adapter missing", sourceHash: source.sourceHash};
    }
    try {
      const metadata = JSON.parse(readFileSync(metadataPath, "utf8")) as AdapterMetadata;
      if (metadata.sourceHash !== source.sourceHash) {
        return {harness: target.harness, directory, valid: false, reason: "source hash drift", sourceHash: source.sourceHash};
      }
      if (sha256Bytes(readFileSync(skillPath)) !== metadata.skillHash) {
        return {harness: target.harness, directory, valid: false, reason: "generated SKILL drift", sourceHash: source.sourceHash};
      }
      const openaiPath = join(directory, "agents", "openai.yaml");
      if (metadata.openaiHash !== null && (!existsSync(openaiPath) || sha256Bytes(readFileSync(openaiPath)) !== metadata.openaiHash)) {
        return {harness: target.harness, directory, valid: false, reason: "generated openai.yaml drift", sourceHash: source.sourceHash};
      }
      return {harness: target.harness, directory, valid: true, reason: "ok", sourceHash: source.sourceHash};
    } catch (error) {
      return {
        harness: target.harness,
        directory,
        valid: false,
        reason: error instanceof Error ? error.message : String(error),
        sourceHash: source.sourceHash
      };
    }
  });
}

export function planAdapters(sourceDir: string, targets = adapterTargets()): {
  sourceDir: string;
  sourceHash: string;
  targets: AdapterTarget[];
} {
  const source = readSource(sourceDir);
  return {sourceDir: source.sourceDir, sourceHash: source.sourceHash, targets};
}
