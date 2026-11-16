export const STRICT_TYPES = ["task", "evidence", "repository", "policy"] as const;

export type StrictObjectType = (typeof STRICT_TYPES)[number];
export type ValidationMode = "compatibility" | "strict";

export interface ParsedMarkdown {
  path: string;
  source: string;
  frontmatterSource: string;
  body: string;
  data: Record<string, unknown>;
}

export interface ValidationIssue {
  code: string;
  path: string;
  message: string;
  pointer?: string;
  details?: Record<string, unknown>;
}

export interface ValidationResult {
  valid: boolean;
  code: string;
  issues: ValidationIssue[];
  documents: ParsedMarkdown[];
}

export interface ActionRequest {
  action_id: string;
  action: string;
  task_ref: string;
  expected_generation?: number;
  expected_state?: string;
}

export interface ValidationContext {
  repoRoot?: string;
  environmentProbeResults?: Record<string, string>;
  fixedNow?: string;
  actionRequest?: ActionRequest;
}

export interface GateSpec {
  spec_version: number;
  cwd_relative: string;
  command_argv: string[];
  input_globs: string[];
  environment_probes: string[];
  point_in_time?: boolean;
}

export interface GraphObject {
  ref: string;
  kind: string;
  document: ParsedMarkdown;
  data: Record<string, unknown>;
}
