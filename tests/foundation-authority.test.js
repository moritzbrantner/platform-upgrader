import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

import {
  auditBoringFoundationV1,
  runCodingToolingFoundationAudit,
} from "../src/foundation-authority.js";

const roots = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
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

function fakeCodingTooling(statuses) {
  const root = temporaryRoot("platform-upgrader-authority-tooling-");
  mkdirSync(path.join(root, "src"), { recursive: true });
  const serialized = JSON.stringify(statuses);
  writeFileSync(
    path.join(root, "src", "entry.ts"),
    `const statuses = ${serialized};\nconst components = Object.fromEntries(Object.entries(statuses).map(([name, status]) => [name, { status, diagnostics: [] }]));\nconst values = Object.values(statuses);\nconst status = values.includes("invalid") ? "failed" : values.includes("unsupported") ? "unavailable" : values.includes("missing") ? "failed" : "passed";\nconsole.log(JSON.stringify({ schemaVersion: 1, operation: "foundation", status, durationMs: 0, data: { reportVersion: 1, root: process.cwd(), components }, diagnostics: [] }));\nprocess.exitCode = status === "passed" ? 0 : status === "failed" ? 1 : 2;\n`,
  );
  return root;
}

describe("coding-tooling foundation authority", () => {
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

  test("fails closed when the requested coding-tooling source checkout is unavailable", () => {
    const repoRoot = repositoryFixture();
    const missingRoot = path.join(repoRoot, "missing-coding-tooling");

    const authority = runCodingToolingFoundationAudit(repoRoot, missingRoot);
    expect(authority.status).toBe("invalid");
    expect(authority.reason).toBe("coding-tooling-entry-missing");

    const audit = auditBoringFoundationV1(repoRoot, { codingToolingRoot: missingRoot });
    expect(audit.safeToApply).toBe(false);
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
