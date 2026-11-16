import {compareIssues} from "./errors.js";
import {evidenceFreshness} from "./digest.js";
import type {
  GraphObject,
  ParsedMarkdown,
  ValidationContext,
  ValidationIssue
} from "./types.js";

const idFieldByType: Record<string, string> = {
  task: "task_id",
  evidence: "evidence_id",
  repository: "repo_id",
  policy: "policy_id"
};

const refKindByType: Record<string, string> = {
  task: "task",
  evidence: "evidence",
  repository: "repo",
  policy: "policy"
};

const relationEndpoints: Record<string, {sources: string[]; target: string}> = {
  changes: {sources: ["task"], target: "repository"},
  depends_on: {sources: ["task"], target: "task"},
  governed_by: {sources: ["task", "repository"], target: "policy"},
  evidence_for: {sources: ["evidence"], target: "task"},
  observed_repo: {sources: ["evidence"], target: "repository"},
  supersedes: {sources: ["task"], target: "task"}
};

const statusByTaskState: Record<string, string> = {
  planned: "active",
  implementing: "active",
  verifying: "active",
  reviewing: "active",
  blocked: "active",
  paused: "paused",
  done: "done",
  cancelled: "archived",
  superseded: "archived"
};

const allowedActionFrom: Record<string, string[]> = {
  claim_work: ["planned"],
  submit_for_verify: ["implementing"],
  record_gate_failed: ["verifying"],
  submit_for_review: ["verifying"],
  request_changes: ["reviewing"],
  complete_task: ["reviewing"],
  pause_task: ["planned", "implementing", "verifying", "reviewing", "blocked"],
  resume_task: ["paused"],
  block_task: ["planned", "implementing", "verifying", "reviewing", "paused"],
  unblock_task: ["blocked"],
  cancel_task: ["planned", "implementing", "verifying", "reviewing", "blocked", "paused"],
  supersede_task: ["planned", "implementing", "verifying", "reviewing", "blocked", "paused", "done"]
};

interface LinkValue {
  rel: string;
  target: string;
}

function linksOf(object: GraphObject): LinkValue[] {
  if (!Array.isArray(object.data.links)) return [];
  return object.data.links.filter((value): value is LinkValue => {
    if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
    const record = value as Record<string, unknown>;
    return typeof record.rel === "string" && typeof record.target === "string";
  });
}

export function objectRef(document: ParsedMarkdown): string | null {
  const type = String(document.data.type ?? "");
  const idField = idFieldByType[type];
  const kind = refKindByType[type];
  if (!idField || !kind || typeof document.data[idField] !== "string") return null;
  return `${kind}:${String(document.data[idField])}`;
}

function asGraphObject(document: ParsedMarkdown): GraphObject | null {
  const ref = objectRef(document);
  if (!ref) return null;
  return {ref, kind: String(document.data.type), document, data: document.data};
}

function issue(
  code: string,
  object: GraphObject,
  message: string,
  pointer?: string,
  details?: Record<string, unknown>
): ValidationIssue {
  return {
    code,
    path: object.document.path,
    message,
    ...(pointer !== undefined ? {pointer} : {}),
    ...(details !== undefined ? {details} : {})
  };
}

function relationTargets(object: GraphObject, relation: string): string[] {
  return linksOf(object).filter((link) => link.rel === relation).map((link) => link.target);
}

function cycleIn(objects: GraphObject[], relation: string): GraphObject | null {
  const taskByRef = new Map(objects.filter((object) => object.kind === "task").map((object) => [object.ref, object]));
  const edges = new Map<string, string[]>();
  for (const object of taskByRef.values()) {
    edges.set(object.ref, relationTargets(object, relation).filter((target) => taskByRef.has(target)));
  }

  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (ref: string): string | null => {
    if (visiting.has(ref)) return ref;
    if (visited.has(ref)) return null;
    visiting.add(ref);
    for (const target of edges.get(ref) ?? []) {
      const found = visit(target);
      if (found) return found;
    }
    visiting.delete(ref);
    visited.add(ref);
    return null;
  };

  for (const ref of [...edges.keys()].sort((left, right) => Buffer.compare(Buffer.from(left), Buffer.from(right)))) {
    const found = visit(ref);
    if (found) return taskByRef.get(found) ?? null;
  }
  return null;
}

function literalPrefix(glob: string): string {
  const index = glob.search(/[?*[{]/);
  return (index < 0 ? glob : glob.slice(0, index)).replace(/\/+$/, "");
}

function scopesOverlap(left: string[], right: string[]): boolean {
  return left.some((leftGlob) => {
    const leftPrefix = literalPrefix(leftGlob);
    return right.some((rightGlob) => {
      const rightPrefix = literalPrefix(rightGlob);
      return leftPrefix.length === 0 || rightPrefix.length === 0 ||
        leftPrefix === rightPrefix ||
        leftPrefix.startsWith(`${rightPrefix}/`) ||
        rightPrefix.startsWith(`${leftPrefix}/`);
    });
  });
}

function activeClaim(object: GraphObject): boolean {
  return object.kind === "task" && object.data.claim !== null && typeof object.data.claim === "object";
}

function changedRepos(object: GraphObject): string[] {
  return relationTargets(object, "changes");
}

function sameRepository(left: GraphObject, right: GraphObject): boolean {
  const rightRepos = new Set(changedRepos(right));
  return changedRepos(left).some((repo) => rightRepos.has(repo));
}

function cardinalityIssues(object: GraphObject): ValidationIssue[] {
  const counts = new Map<string, number>();
  for (const link of linksOf(object)) counts.set(link.rel, (counts.get(link.rel) ?? 0) + 1);
  const output: ValidationIssue[] = [];
  const exact = (rel: string, count: number): void => {
    if ((counts.get(rel) ?? 0) !== count) {
      output.push(issue("E_LINK_CARDINALITY", object, `${object.ref} requires exactly ${count} ${rel} link(s)`, "/links"));
    }
  };
  if (object.kind === "task") {
    if ((counts.get("changes") ?? 0) < 1) {
      output.push(issue("E_LINK_CARDINALITY", object, `${object.ref} requires at least one changes link`, "/links"));
    }
    exact("governed_by", 1);
    if ((counts.get("supersedes") ?? 0) > 1) {
      output.push(issue("E_LINK_CARDINALITY", object, `${object.ref} allows at most one supersedes link`, "/links"));
    }
  }
  if (object.kind === "repository") exact("governed_by", 1);
  if (object.kind === "evidence") {
    exact("evidence_for", 1);
    exact("observed_repo", 1);
  }
  return output;
}

export function validateGraph(documents: ParsedMarkdown[], context: ValidationContext = {}): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const objects = documents.map(asGraphObject).filter((value): value is GraphObject => value !== null);
  const objectsByRef = new Map<string, GraphObject>();

  for (const object of objects) {
    if (objectsByRef.has(object.ref)) {
      issues.push(issue("E_ID_DUPLICATE", object, `duplicate object id: ${object.ref}`));
    } else {
      objectsByRef.set(object.ref, object);
    }
  }

  for (const object of objects) {
    issues.push(...cardinalityIssues(object));
    for (const [index, link] of linksOf(object).entries()) {
      const endpoint = relationEndpoints[link.rel];
      if (!endpoint) continue;
      const target = objectsByRef.get(link.target);
      if (!target) {
        issues.push(issue("E_LINK_TARGET_MISSING", object, `missing link target: ${link.target}`, `/links/${index}/target`));
        continue;
      }
      if (!endpoint.sources.includes(object.kind) || target.kind !== endpoint.target) {
        issues.push(issue(
          "E_LINK_ENDPOINT_TYPE",
          object,
          `invalid ${link.rel} endpoints: ${object.kind} -> ${target.kind}`,
          `/links/${index}`
        ));
      }
      if ((link.rel === "depends_on" || link.rel === "supersedes") && link.target === object.ref) {
        issues.push(issue("E_LINK_ENDPOINT_TYPE", object, `${link.rel} cannot self-reference`, `/links/${index}/target`));
      }
    }

    if (object.kind === "task") {
      const expectedStatus = statusByTaskState[String(object.data.task_state)];
      if (expectedStatus && object.data.status !== expectedStatus) {
        issues.push(issue(
          "E_STATUS_DERIVATION",
          object,
          `status ${String(object.data.status)} does not match task_state ${String(object.data.task_state)}`,
          "/status"
        ));
      }
    }
  }

  const dependencyCycle = cycleIn(objects, "depends_on");
  if (dependencyCycle) issues.push(issue("E_DEPENDENCY_CYCLE", dependencyCycle, "depends_on graph contains a cycle", "/links"));
  const supersedesCycle = cycleIn(objects, "supersedes");
  if (supersedesCycle) issues.push(issue("E_SUPERSEDES_CYCLE", supersedesCycle, "supersedes graph contains a cycle", "/links"));

  const claimed = objects.filter(activeClaim);
  for (let leftIndex = 0; leftIndex < claimed.length; leftIndex += 1) {
    const left = claimed[leftIndex];
    if (!left) continue;
    for (let rightIndex = leftIndex + 1; rightIndex < claimed.length; rightIndex += 1) {
      const right = claimed[rightIndex];
      if (!right || !sameRepository(left, right)) continue;
      const leftScope = Array.isArray(left.data.write_scope) ? left.data.write_scope.map(String) : [];
      const rightScope = Array.isArray(right.data.write_scope) ? right.data.write_scope.map(String) : [];
      if (scopesOverlap(leftScope, rightScope)) {
        issues.push(issue(
          "E_CLAIM_SCOPE_CONFLICT",
          right,
          `active claim scope overlaps ${left.ref}`,
          "/write_scope",
          {other: left.ref}
        ));
      }
    }
  }

  if (context.actionRequest) {
    const task = objectsByRef.get(context.actionRequest.task_ref);
    if (task) {
      const allowed = allowedActionFrom[context.actionRequest.action] ?? [];
      if (!allowed.includes(String(task.data.task_state))) {
        issues.push(issue(
          "E_TRANSITION_FORBIDDEN",
          task,
          `${context.actionRequest.action} is forbidden from ${String(task.data.task_state)}`,
          "/task_state"
        ));
      }
    }
  }

  const evidenceObjects = objects.filter((object) => object.kind === "evidence");
  for (const task of objects.filter((object) => object.kind === "task" && object.data.task_state === "done")) {
    const policyRef = relationTargets(task, "governed_by")[0];
    const policy = policyRef ? objectsByRef.get(policyRef) : undefined;
    const requiredGates = Array.isArray(task.data.required_gates) ? task.data.required_gates.map(String) : [];
    for (const gateId of requiredGates) {
      const candidates = evidenceObjects.filter((evidence) => {
        return evidence.data.gate_id === gateId && relationTargets(evidence, "evidence_for").includes(task.ref);
      });
      if (candidates.length === 0) {
        issues.push(issue("E_REQUIRED_GATE_MISSING", task, `required gate has no Evidence: ${gateId}`, "/required_gates"));
        continue;
      }
      if (!policy) continue;
      if (!context.repoRoot || !context.environmentProbeResults) continue;
      const freshness = candidates.map((evidence) => ({evidence, code: evidenceFreshness(evidence, policy, context)}));
      if (freshness.some((result) => result.code === "FRESH")) continue;
      const first = freshness[0];
      if (first) {
        issues.push(issue(first.code, first.evidence, `Evidence is not fresh for ${task.ref}/${gateId}`));
      }
    }
  }

  return issues.sort(compareIssues);
}
