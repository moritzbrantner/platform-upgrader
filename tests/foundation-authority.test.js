import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, test } from "bun:test";

import {
  auditBoringFoundationV1,
  runCodingToolingFoundationAudit,
} from "../src/foundation-authority.js";

const roots = [];

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

function temporaryRoot(prefix) {
  const root = mkdtempSync(path.join(tmpdir(), prefix));
  roots.push(root);
  return root;
}

function repositoryFixture() {
  const root = temporaryRoot("platform-upgrader-authority-repo-");
  writeFileSync(
    path.join(root, "package.json"),
    `${JSON.stringify({ packageManager: "bun@1.4.0", scripts: { test: "bun test" } }, null, 2)}\n`,
  );
  return root;
}

function fakeCodingToolingProgram(source) {
  const root = temporaryRoot("platform-upgrader-authority-tooling-");
  mkdirSync(path.join(root, "src"), { recursive: true });
  writeFileSync(path.join(root, "src", "entry.ts"), source);
  return root;
}

function expectedReportStatus(statuses) {
  const values = Object.values(statuses);
  if (values.includes("invalid")) {
    return "failed";
  }
  if (values.includes("unsupported")) {
    return "unavailable";
  }
  if (values.includes("missing")) {
    return "failed";
  }
  return "passed";
}

function fakeCodingTooling(
  statuses,
  { reportStatus = expectedReportStatus(statuses), reportedRoot, includeRoot = true } = {},
) {
  const serializedStatuses = JSON.stringify(statuses);
  const serializedStatus = JSON.stringify(reportStatus);
  const rootExpression = reportedRoot === undefined ? "process.cwd()" : JSON.stringify(reportedRoot);
  const rootField = includeRoot ? `root: ${rootExpression},` : "";
  return fakeCodingToolingProgram(
    `const statuses = ${serializedStatuses};\nconst components = Object.fromEntries(Object.entries(statuses).map(([name, status]) => [name, { status, diagnostics: [] }]));\nconsole.log(JSON.stringify({ schemaVersion: 1, operation: "foundation", status: ${serializedStatus}, durationMs: 0, data: { reportVersion: 1, ${rootField} components }, diagnostics: [] }));\n`,
  );
}

describe("coding-tooling foundation authority", () => {
  test("accepts a consistent adopted foundation report", () => {
    const repoRoot = repositoryFixture();
    const toolingRoot = fakeCodingTooling({
      environment: "adopted",
      tooling: "adopted",
      commands: "adopted",
      conventions: "adopted",
      renovate: "adopted",
    });

    const authority = runCodingToolingFoundationAudit(repoRoot, toolingRoot);
    expect(authority.status).toBe("passed");
    expect(authority.reason).toBe("coding-tooling-foundation-passed");
    expect(authority.blockers).toEqual([]);
    expect(authority.pending).toEqual([]);
  });

  test("treats missing foundation pieces as pending rather than unsafe", () => {
    const repoRoot = repositoryFixture();
    const toolingRoot = fakeCodingTooling({
      environment: "missing",
      tooling: "missing",
      commands: "missing",
      conventions: "missing",
      renovate: "missing",
    });

    const authority = runCodingToolingFoundationAudit(repoRoot, toolingRoot);
    expect(authority.status).toBe("pending");
    expect(authority.blockers).toEqual([]);
    expect(authority.pending).toHaveLength(5);

    const audit = auditBoringFoundationV1(repoRoot, { codingToolingRoot: toolingRoot });
    expect(audit.safeToApply).toBe(true);
    expect(audit.complete).toBe(false);
    expect(audit.authority.status).toBe("pending");
  });

  test("fails closed when coding-tooling reports an invalid foundation component", () => {
    const repoRoot = repositoryFixture();
    const toolingRoot = fakeCodingTooling({
      environment: "invalid",
      tooling: "adopted",
      commands: "adopted",
      conventions: "adopted",
      renovate: "adopted",
    });

    const audit = auditBoringFoundationV1(repoRoot, { codingToolingRoot: toolingRoot });
    expect(audit.safeToApply).toBe(false);
    expect(audit.authority.status).toBe("blocked");
    expect(audit.authority.blockers).toEqual([{ component: "environment", status: "invalid" }]);
  });

  test("fails closed when coding-tooling reports an unsupported foundation component", () => {
    const repoRoot = repositoryFixture();
    const toolingRoot = fakeCodingTooling({
      environment: "adopted",
      tooling: "adopted",
      commands: "unsupported",
      conventions: "adopted",
      renovate: "adopted",
    });

    const authority = runCodingToolingFoundationAudit(repoRoot, toolingRoot);
    expect(authority.status).toBe("blocked");
    expect(authority.reason).toBe("coding-tooling-foundation-blocked");
    expect(authority.blockers).toEqual([{ component: "commands", status: "unsupported" }]);
  });

  test("fails closed when the requested coding-tooling source checkout is unavailable", () => {
    const repoRoot = repositoryFixture();
    const missingRoot = path.join(repoRoot, "missing-coding-tooling");

    const authority = runCodingToolingFoundationAudit(repoRoot, missingRoot);
    expect(authority.status).toBe("invalid");
    expect(authority.reason).toBe("coding-tooling-entry-missing");

    const audit = auditBoringFoundationV1(repoRoot, { codingToolingRoot: missingRoot });
    expect(audit.safeToApply).toBe(false);
  });

  test("fails closed when coding-tooling emits malformed JSON", () => {
    const repoRoot = repositoryFixture();
    const toolingRoot = fakeCodingToolingProgram('console.log("not-json");\n');

    const authority = runCodingToolingFoundationAudit(repoRoot, toolingRoot);
    expect(authority.status).toBe("invalid");
    expect(authority.reason).toBe("coding-tooling-foundation-json-invalid");
    expect(authority.blockers).toEqual([{ component: "authority", status: "invalid" }]);
  });

  test("fails closed when coding-tooling reports a different repository root", () => {
    const repoRoot = repositoryFixture();
    const toolingRoot = fakeCodingTooling(
      {
        environment: "adopted",
        tooling: "adopted",
        commands: "adopted",
        conventions: "adopted",
        renovate: "adopted",
      },
      { reportedRoot: path.join(repoRoot, "other") },
    );

    const authority = runCodingToolingFoundationAudit(repoRoot, toolingRoot);
    expect(authority.status).toBe("invalid");
    expect(authority.reason).toBe("coding-tooling-foundation-root-mismatch");
  });

  test("fails closed when coding-tooling omits the audited repository root", () => {
    const repoRoot = repositoryFixture();
    const toolingRoot = fakeCodingTooling(
      {
        environment: "adopted",
        tooling: "adopted",
        commands: "adopted",
        conventions: "adopted",
        renovate: "adopted",
      },
      { includeRoot: false },
    );

    const authority = runCodingToolingFoundationAudit(repoRoot, toolingRoot);
    expect(authority.status).toBe("invalid");
    expect(authority.reason).toBe("coding-tooling-foundation-root-invalid");
  });

  test("fails closed when top-level status contradicts component statuses", () => {
    const repoRoot = repositoryFixture();
    const toolingRoot = fakeCodingTooling(
      {
        environment: "missing",
        tooling: "adopted",
        commands: "adopted",
        conventions: "adopted",
        renovate: "adopted",
      },
      { reportStatus: "passed" },
    );

    const authority = runCodingToolingFoundationAudit(repoRoot, toolingRoot);
    expect(authority.status).toBe("invalid");
    expect(authority.reason).toBe("coding-tooling-foundation-status-inconsistent");
  });

  test("fails closed when coding-tooling reports an execution error envelope", () => {
    const repoRoot = repositoryFixture();
    const toolingRoot = fakeCodingTooling(
      {
        environment: "adopted",
        tooling: "adopted",
        commands: "adopted",
        conventions: "adopted",
        renovate: "adopted",
      },
      { reportStatus: "error" },
    );

    const authority = runCodingToolingFoundationAudit(repoRoot, toolingRoot);
    expect(authority.status).toBe("invalid");
    expect(authority.reason).toBe("coding-tooling-foundation-reported-error");
  });

  test("CLI accepts --coding-tooling-root without an explicit repository path", () => {
    const repoRoot = repositoryFixture();
    const toolingRoot = fakeCodingTooling({
      environment: "missing",
      tooling: "missing",
      commands: "missing",
      conventions: "missing",
      renovate: "missing",
    });
    const cliPath = path.resolve(import.meta.dir, "..", "src", "cli.js");
    const execution = spawnSync(
      "bun",
      [cliPath, "audit", "boring-foundation-v1", "--coding-tooling-root", toolingRoot],
      { cwd: repoRoot, encoding: "utf8" },
    );

    expect(execution.status).toBe(0);
    const report = JSON.parse(execution.stdout);
    expect(report.repoName).toBe(path.basename(repoRoot));
    expect(report.authority.status).toBe("pending");
  });
});
