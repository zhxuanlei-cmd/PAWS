import type { ValidationIssue } from "./types.js";

export const ERROR_PRECEDENCE = [
  "E_PARSE",
  "E_SCHEMA",
  "E_ID_DUPLICATE",
  "E_LINK_TARGET_MISSING",
  "E_LINK_ENDPOINT_TYPE",
  "E_LINK_CARDINALITY",
  "E_DEPENDENCY_CYCLE",
  "E_SUPERSEDES_CYCLE",
  "E_STATUS_DERIVATION",
  "E_TRANSITION_FORBIDDEN",
  "E_CLAIM_SCOPE_CONFLICT",
  "E_REQUIRED_GATE_MISSING",
  "E_EVIDENCE_FAILED",
  "E_EVIDENCE_STALE_INPUT",
  "E_EVIDENCE_STALE_COMMAND",
  "E_EVIDENCE_STALE_ENVIRONMENT",
  "E_EVIDENCE_STALE_LOG",
  "E_EVIDENCE_EXPIRED",
  "E_EVIDENCE_CONTEXT_MISSING",
  "E_ACTION_PRECONDITION",
  "E_POLICY_DENIED",
  "E_LOCK_BUSY",
  "E_RECOVERY_REQUIRED"
] as const;

const precedence: ReadonlyMap<string, number> = new Map(ERROR_PRECEDENCE.map((code, index) => [code, index]));

export class PawsError extends Error {
  readonly code: string;
  readonly path: string;
  readonly pointer: string | undefined;
  readonly details: Record<string, unknown> | undefined;

  constructor(issue: ValidationIssue) {
    super(issue.message);
    this.name = "PawsError";
    this.code = issue.code;
    this.path = issue.path;
    this.pointer = issue.pointer;
    this.details = issue.details;
  }

  toIssue(): ValidationIssue {
    const issue: ValidationIssue = {
      code: this.code,
      path: this.path,
      message: this.message
    };
    if (this.pointer !== undefined) issue.pointer = this.pointer;
    if (this.details !== undefined) issue.details = this.details;
    return issue;
  }
}

export function compareIssues(left: ValidationIssue, right: ValidationIssue): number {
  const leftRank = precedence.get(left.code) ?? Number.MAX_SAFE_INTEGER;
  const rightRank = precedence.get(right.code) ?? Number.MAX_SAFE_INTEGER;
  if (leftRank !== rightRank) return leftRank - rightRank;
  const pathOrder = Buffer.compare(Buffer.from(left.path), Buffer.from(right.path));
  if (pathOrder !== 0) return pathOrder;
  return Buffer.compare(Buffer.from(left.pointer ?? ""), Buffer.from(right.pointer ?? ""));
}
