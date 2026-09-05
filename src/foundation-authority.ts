import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";

import {
  applyBoringFoundationV1 as applyLocalBoringFoundationV1,
  auditBoringFoundationV1 as auditLocalBoringFoundationV1,
} from "./foundation.js";

type JsonObject = Record<string, unknown>;
type ComponentStatus = "missing" | "adopted" | "invalid" | "unsupported";
type FoundationReportStatus = "passed" | "failed" | "unavailable" | "error";
type FoundationAuthorityOptions = {
  codingToolingRoot?: string | null | undefined;
};

type AuthorityEntry = {
  component: string;
  status: ComponentStatus;
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

function invalidAuthority(reason: string, diagnostic: string): AuthorityResult {
  return {
    status: "invalid",
    reason,
    blockers: [{ component: "authority", status: "invalid" }],
    pending: [],
    diagnostics: [diagnostic],
  };
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

function foundationReportStatus(value: unknown): FoundationReportStatus | null {
  if (value === "passed" || value === "failed" || value === "unavailable" || value === "error") {
    return value;
  }
  return null;
}

function expectedFoundationReportStatus(
  blockers: AuthorityEntry[],
  pending: AuthorityEntry[],
): Exclude<FoundationReportStatus, "error"> {
  if (blockers.some((entry) => entry.status === "invalid")) {
    return "failed";
  }
  if (blockers.some((entry) => entry.status === "unsupported")) {
    return "unavailable";
  }
  if (pending.length > 0) {
    return "failed";
  }
  return "passed";
}

function validateFoundationReport(report: unknown, repoRoot: string): AuthorityResult {
  if (
    !isRecord(report) ||
    report.schemaVersion !== 1 ||
    report.operation !== "foundation" ||
    !isRecord(report.data) ||
    report.data.reportVersion !== 1
  ) {
    return invalidAuthority(
      "coding-tooling-foundation-report-invalid",
      "coding-tooling foundation audit returned an incompatible report",
    );
  }

  const reportStatus = foundationReportStatus(report.status);
  if (!reportStatus) {
    return invalidAuthority(
      "coding-tooling-foundation-status-invalid",
      "coding-tooling foundation audit returned an invalid top-level status",
    );
  }
  if (reportStatus === "error") {
    return invalidAuthority(
      "coding-tooling-foundation-reported-error",
      "coding-tooling foundation audit reported an execution error",
    );
  }

  const reportedRoot = typeof report.data.root === "string" ? path.resolve(report.data.root) : null;
  const expectedRoot = path.resolve(repoRoot);
  if (!reportedRoot) {
    return invalidAuthority(
      "coding-tooling-foundation-root-invalid",
      "coding-tooling foundation audit did not report the audited repository root",
    );
  }
  if (reportedRoot !== expectedRoot) {
    return invalidAuthority(
      "coding-tooling-foundation-root-mismatch",
      `coding-tooling audited ${reportedRoot} instead of ${expectedRoot}`,
    );
  }

  const statuses = componentStatuses(report);
  if (!statuses) {
    return invalidAuthority(
      "coding-tooling-foundation-components-invalid",
      "coding-tooling foundation audit returned invalid component statuses",
    );
  }

  const blockers = Object.entries(statuses)
    .filter(([, status]) => status === "invalid" || status === "unsupported")
    .map(([component, status]) => ({ component, status }));
  const pending = Object.entries(statuses)
    .filter(([, status]) => status === "missing")
    .map(([component, status]) => ({ component, status }));
  const expectedReportStatus = expectedFoundationReportStatus(blockers, pending);
  if (reportStatus !== expectedReportStatus) {
    return invalidAuthority(
      "coding-tooling-foundation-status-inconsistent",
      `coding-tooling foundation audit reported ${reportStatus} but its components imply ${expectedReportStatus}`,
    );
  }

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
    reportStatus,
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
    return invalidAuthority(
      "coding-tooling-entry-missing",
      `coding-tooling entrypoint is missing: ${entryPath}`,
    );
  }

  const execution = spawnSync("bun", [entryPath, "foundation", "audit", "--json"], {
    cwd: path.resolve(repoRoot),
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (execution.error || typeof execution.stdout !== "string" || !execution.stdout.trim()) {
    const stderr = typeof execution.stderr === "string" ? execution.stderr.trim() : "";
    return invalidAuthority(
      "coding-tooling-foundation-execution-failed",
      execution.error instanceof Error
        ? execution.error.message
        : stderr || "coding-tooling foundation audit produced no report",
    );
  }

  let report: unknown;
  try {
    report = JSON.parse(execution.stdout) as unknown;
  } catch (error) {
    return invalidAuthority(
      "coding-tooling-foundation-json-invalid",
      error instanceof Error ? error.message : String(error),
    );
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
