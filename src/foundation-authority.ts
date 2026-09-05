import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";

import {
  applyBoringFoundationV1 as applyLocalBoringFoundationV1,
  auditBoringFoundationV1 as auditLocalBoringFoundationV1,
} from "./foundation.js";

type JsonObject = Record<string, unknown>;
type ComponentStatus = "missing" | "adopted" | "invalid" | "unsupported";
type FoundationAuthorityOptions = {
  codingToolingRoot?: string | null | undefined;
};

type AuthorityEntry = {
  component: string;
  status: ComponentStatus | "invalid";
};

type AuthorityResult = JsonObject & {
  status: string;
  reason: string;
  blockers: AuthorityEntry[];
  pending: AuthorityEntry[];
};

function isRecord(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function componentStatuses(report: unknown): Record<string, ComponentStatus> | null {
  if (!isRecord(report) || !isRecord(report.data) || !isRecord(report.data.components)) {
    return null;
  }

  const result: Record<string, ComponentStatus> = {};
  for (const [name, value] of Object.entries(report.data.components)) {
    if (!isRecord(value)) {
      return null;
    }
    const status = value.status;
    if (
      status !== "missing" &&
      status !== "adopted" &&
      status !== "invalid" &&
      status !== "unsupported"
    ) {
      return null;
    }
    result[name] = status;
  }
  return result;
}

function validateFoundationReport(report: unknown, repoRoot: string): AuthorityResult {
  if (
    !isRecord(report) ||
    report.schemaVersion !== 1 ||
    report.operation !== "foundation" ||
    !isRecord(report.data) ||
    report.data.reportVersion !== 1
  ) {
    return {
      status: "invalid",
      reason: "coding-tooling-foundation-report-invalid",
      blockers: [{ component: "authority", status: "invalid" }],
      pending: [],
      diagnostics: ["coding-tooling foundation audit returned an incompatible report"],
    };
  }

  const statuses = componentStatuses(report);
  if (!statuses) {
    return {
      status: "invalid",
      reason: "coding-tooling-foundation-components-invalid",
      blockers: [{ component: "authority", status: "invalid" }],
      pending: [],
      diagnostics: ["coding-tooling foundation audit returned invalid component statuses"],
    };
  }

  const reportedRoot = typeof report.data.root === "string" ? path.resolve(report.data.root) : null;
  const expectedRoot = path.resolve(repoRoot);
  if (reportedRoot && reportedRoot !== expectedRoot) {
    return {
      status: "invalid",
      reason: "coding-tooling-foundation-root-mismatch",
      blockers: [{ component: "authority", status: "invalid" }],
      pending: [],
      diagnostics: [`coding-tooling audited ${reportedRoot} instead of ${expectedRoot}`],
    };
  }

  const blockers = Object.entries(statuses)
    .filter(([, status]) => status === "invalid" || status === "unsupported")
    .map(([component, status]) => ({ component, status }));
  const pending = Object.entries(statuses)
    .filter(([, status]) => status === "missing")
    .map(([component, status]) => ({ component, status }));

  let status = "passed";
  let reason = "coding-tooling-foundation-passed";
  if (blockers.length > 0) {
    status = "blocked";
    reason = "coding-tooling-foundation-blocked";
  } else if (pending.length > 0) {
    status = "pending";
    reason = "coding-tooling-foundation-incomplete";
  }

  return {
    status,
    reason,
    reportStatus: report.status,
    components: statuses,
    blockers,
    pending,
    diagnostics: Array.isArray(report.diagnostics) ? report.diagnostics : [],
  };
}

export function runCodingToolingFoundationAudit(
  repoRoot: string,
  codingToolingRoot: string | null | undefined,
): AuthorityResult {
  if (!codingToolingRoot) {
    return {
      status: "not-requested",
      reason: "coding-tooling-foundation-authority-not-requested",
      blockers: [],
      pending: [],
    };
  }

  const resolvedToolingRoot = path.resolve(codingToolingRoot);
  const entryPath = path.join(resolvedToolingRoot, "src", "entry.ts");
  if (!existsSync(entryPath)) {
    return {
      status: "invalid",
      reason: "coding-tooling-entry-missing",
      blockers: [{ component: "authority", status: "invalid" }],
      pending: [],
      diagnostics: [`coding-tooling entrypoint is missing: ${entryPath}`],
    };
  }

  const execution = spawnSync("bun", [entryPath, "foundation", "audit", "--json"], {
    cwd: path.resolve(repoRoot),
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (execution.error || typeof execution.stdout !== "string" || !execution.stdout.trim()) {
    const stderr = typeof execution.stderr === "string" ? execution.stderr.trim() : "";
    return {
      status: "invalid",
      reason: "coding-tooling-foundation-execution-failed",
      blockers: [{ component: "authority", status: "invalid" }],
      pending: [],
      diagnostics: [
        execution.error instanceof Error
          ? execution.error.message
          : stderr || "coding-tooling foundation audit produced no report",
      ],
    };
  }

  let report: unknown;
  try {
    report = JSON.parse(execution.stdout) as unknown;
  } catch (error) {
    return {
      status: "invalid",
      reason: "coding-tooling-foundation-json-invalid",
      blockers: [{ component: "authority", status: "invalid" }],
      pending: [],
      diagnostics: [error instanceof Error ? error.message : String(error)],
    };
  }

  return {
    ...validateFoundationReport(report, repoRoot),
    codingToolingRoot: resolvedToolingRoot,
    exitCode: execution.status,
    report,
  };
}

export function auditBoringFoundationV1(
  repoRoot: string,
  { codingToolingRoot = null }: FoundationAuthorityOptions = {},
) {
  const local = auditLocalBoringFoundationV1(repoRoot);
  const authority = runCodingToolingFoundationAudit(repoRoot, codingToolingRoot);
  const authorityBlocked = authority.status === "invalid" || authority.status === "blocked";
  const authorityComplete = authority.status === "not-requested" || authority.status === "passed";

  return {
    ...local,
    authority,
    safeToApply: local.safeToApply && !authorityBlocked,
    complete: local.complete && authorityComplete,
  };
}

export function applyBoringFoundationV1(
  repoRoot: string,
  { codingToolingRoot = null }: FoundationAuthorityOptions = {},
) {
  const before = auditBoringFoundationV1(repoRoot, { codingToolingRoot });
  if (!before.safeToApply) {
    return {
      schemaVersion: 1,
      migration: before.migration,
      repoName: before.repoName,
      changed: [],
      skipped: [...before.conflicts, ...before.authority.blockers],
      audit: before,
      authority: { before: before.authority, after: null },
    };
  }

  const applied = applyLocalBoringFoundationV1(repoRoot);
  const after = auditBoringFoundationV1(repoRoot, { codingToolingRoot });
  return {
    ...applied,
    audit: after,
    authority: { before: before.authority, after: after.authority },
  };
}
