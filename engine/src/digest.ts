import {createHash} from "node:crypto";
import {existsSync, lstatSync, readFileSync, readdirSync} from "node:fs";
import {isAbsolute, join, matchesGlob, posix, relative, resolve, sep} from "node:path";
import type {GateSpec, GraphObject, ValidationContext} from "./types.js";

export function sha256Bytes(value: string | Buffer): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

export function digestJson(value: unknown): string {
  return sha256Bytes(JSON.stringify(value));
}

function utf8Compare(left: string, right: string): number {
  return Buffer.compare(Buffer.from(left), Buffer.from(right));
}

function literalPrefix(pattern: string): string {
  const index = pattern.search(/[?*[{]/);
  return (index < 0 ? pattern : pattern.slice(0, index)).replace(/\/+$/, "");
}

function couldMatch(relativePath: string, patterns: string[]): boolean {
  return patterns.some((pattern) => {
    const prefix = literalPrefix(pattern);
    return prefix.length === 0 ||
      prefix === relativePath ||
      prefix.startsWith(`${relativePath}/`) ||
      relativePath.startsWith(`${prefix}/`) ||
      matchesGlob(relativePath, pattern);
  });
}

function walkFiles(root: string, patterns: string[], current = root): string[] {
  const output: string[] = [];
  const entries = readdirSync(current, {withFileTypes: true})
    .sort((left, right) => utf8Compare(left.name, right.name));
  for (const entry of entries) {
    const absolute = join(current, entry.name);
    const rel = relative(root, absolute).split(sep).join(posix.sep);
    const stat = lstatSync(absolute);
    if (stat.isSymbolicLink()) {
      if (couldMatch(rel, patterns)) throw new Error(`symlink is not allowed in gate inputs: ${absolute}`);
      continue;
    }
    if (stat.isDirectory() && couldMatch(rel, patterns)) output.push(...walkFiles(root, patterns, absolute));
    if (stat.isFile()) output.push(absolute);
  }
  return output;
}

function safePath(root: string, candidate: string): string {
  if (isAbsolute(candidate)) throw new Error(`absolute path is not allowed: ${candidate}`);
  const resolvedRoot = resolve(root);
  const resolvedCandidate = resolve(root, candidate);
  if (resolvedCandidate !== resolvedRoot && !resolvedCandidate.startsWith(`${resolvedRoot}${sep}`)) {
    throw new Error(`path escapes repository root: ${candidate}`);
  }
  return resolvedCandidate;
}

export function inputDigest(repoRoot: string, gate: GateSpec): string {
  const cwd = safePath(repoRoot, gate.cwd_relative);
  const allFiles = walkFiles(cwd, gate.input_globs);
  const matched = allFiles.filter((absolute) => {
    const rel = relative(cwd, absolute).split(sep).join(posix.sep);
    return gate.input_globs.some((pattern) => matchesGlob(rel, pattern));
  });
  if (matched.length === 0) throw new Error("gate input_globs matched zero files");
  const entries = matched.map((absolute) => {
    const rel = relative(cwd, absolute).split(sep).join(posix.sep);
    return [rel, sha256Bytes(readFileSync(absolute))];
  }).sort((left, right) => utf8Compare(left[0] ?? "", right[0] ?? ""));
  return digestJson(entries);
}

export function commandDigest(gate: GateSpec): string {
  return digestJson([gate.spec_version, gate.cwd_relative, gate.command_argv]);
}

export function environmentDigest(gate: GateSpec, probes: Record<string, string>): string {
  const entries = gate.environment_probes.map((name) => {
    if (!(name in probes)) throw new Error(`missing environment probe: ${name}`);
    return [name, String(probes[name])];
  }).sort((left, right) => utf8Compare(left[0] ?? "", right[0] ?? ""));
  return digestJson(entries);
}

export type FreshnessCode =
  | "FRESH"
  | "E_EVIDENCE_FAILED"
  | "E_EVIDENCE_STALE_INPUT"
  | "E_EVIDENCE_STALE_COMMAND"
  | "E_EVIDENCE_STALE_ENVIRONMENT"
  | "E_EVIDENCE_STALE_LOG"
  | "E_EVIDENCE_EXPIRED"
  | "E_EVIDENCE_CONTEXT_MISSING";

export function evidenceFreshness(
  evidence: GraphObject,
  policy: GraphObject,
  context: ValidationContext
): FreshnessCode {
  const data = evidence.data;
  if (data.result !== "passed" || data.exit_code !== 0) return "E_EVIDENCE_FAILED";
  if (!context.repoRoot || !context.environmentProbeResults) return "E_EVIDENCE_CONTEXT_MISSING";
  const gates = policy.data.gates as Record<string, GateSpec> | undefined;
  const gate = gates?.[String(data.gate_id)];
  if (!gate) return "E_EVIDENCE_CONTEXT_MISSING";
  if (data.gate_spec_version !== gate.spec_version) return "E_EVIDENCE_STALE_COMMAND";

  try {
    if (data.input_digest !== inputDigest(context.repoRoot, gate)) return "E_EVIDENCE_STALE_INPUT";
    if (data.command_digest !== commandDigest(gate)) return "E_EVIDENCE_STALE_COMMAND";
    if (data.environment_digest !== environmentDigest(gate, context.environmentProbeResults)) {
      return "E_EVIDENCE_STALE_ENVIRONMENT";
    }
    const logRef = String(data.log_ref);
    const logPath = safePath(context.repoRoot, logRef);
    if (!existsSync(logPath) || lstatSync(logPath).isSymbolicLink()) return "E_EVIDENCE_STALE_LOG";
    if (data.log_digest !== sha256Bytes(readFileSync(logPath))) return "E_EVIDENCE_STALE_LOG";
  } catch {
    return "E_EVIDENCE_CONTEXT_MISSING";
  }

  if (data.valid_until !== null && data.valid_until !== undefined) {
    const now = new Date(context.fixedNow ?? Date.now());
    const validUntil = new Date(String(data.valid_until));
    if (!Number.isFinite(validUntil.getTime()) || now > validUntil) return "E_EVIDENCE_EXPIRED";
  }
  return "FRESH";
}
