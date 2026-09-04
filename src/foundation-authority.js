import { existsSync } from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

import {
  applyBoringFoundationV1 as applyLocalBoringFoundationV1,
  auditBoringFoundationV1 as auditLocalBoringFoundationV1,
} from "./foundation.js";

function componentStatuses(report) {
  const components = report?.data?.components;
  if (!components || typeof components !== "object" || Array.isArray(components)) return null;
  const result = {};
  for (const [name, value] of Object.entries(components)) {
    const status = value?.status;
    if (!["missing", "adopted", "invalid", "unsupported"].includes(status)) return null;
    result[name] = status;
  }
  return result;
}

function validateFoundationReport(report, repoRoot) {
  if (
    !report ||
    report.schemaVersion !== 1 ||
    report.operation !== "foundation" ||
    report.data?.reportVersion !== 1
  ) {
    return {
      status: "invalid",
      reason: "coding-tooling-foundation-report-invalid",
      diagnostics: ["coding-tooling foundation audit returned an incompatible report"],
    };
  }

  const statuses = componentStatuses(report);
  if (!statuses) {
    return {
      status: "invalid",
      reason: "coding-tooling-foundation-components-invalid",
      diagnostics: ["coding-tooling foundation audit returned invalid component statuses"],
    };
  }

  const reportedRoot = typeof report.data.root === "string" ? path.resolve(report.data.root) : null;
  const expectedRoot = path.resolve(repoRoot);
  if (reportedRoot && reportedRoot !== expectedRoot) {
    return {
      status: "invalid",
      reason: "coding-tooling-foundation-root-mismatch",
      diagnostics: [`coding-tooling audited ${reportedRoot} instead of ${expectedRoot}`],
    };
  }

  const blockers = Object.entries(statuses)
    .filter(([, status]) => status === "invalid" || status === "unsupported")
    .map(([component, status]) => ({ component, status }));
  const pending = Object.entries(statuses)
    .filter(([, status]) => status === "missing")
    .map(([component, status]) => ({ component, status }));

  return {
    status: blockers.length > 0 ? "blocked" : pending.length > 0 ? "pending" : "passed",
    reason:
      blockers.length > 0
        ? "coding-tooling-foundation-blocked"
        : pending.length > 0
          ? "coding-tooling-foundation-incomplete"
          : "coding-tooling-foundation-passed",
    reportStatus: report.status,
    components: statuses,
    blockers,
    pending,
    diagnostics: report.diagnostics ?? [],
  };
}

export function runCodingToolingFoundationAudit(repoRoot, codingToolingRoot) {
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
    return {
      status: "invalid",
      reason: "coding-tooling-foundation-execution-failed",
      blockers: [{ component: "authority", status: "invalid" }],
      pending: [],
      diagnostics: [
        execution.error instanceof Error
          ? execution.error.message
          : execution.stderr?.trim() || "coding-tooling foundation audit produced no report",
      ],
    };
  }

  let report;
  try {
    report = JSON.parse(execution.stdout);
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

export function auditBoringFoundationV1(repoRoot, { codingToolingRoot = null } = {}) {
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

export function applyBoringFoundationV1(repoRoot, { codingToolingRoot = null } = {}) {
  const before = auditBoringFoundationV1(repoRoot, { codingToolingRoot });
  if (!before.safeToApply) {
    return {
      schemaVersion: 1,
      migration: before.migration,
      repoName: before.repoName,
      changed: [],
      skipped: [...before.conflicts, ...(before.authority?.blockers ?? [])],
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
