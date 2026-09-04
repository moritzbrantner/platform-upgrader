import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, test } from "bun:test";

import {
  buildBoringFoundationRolloutReport,
  recordRolloutResult,
  repositoryGitState,
  writeRolloutReport,
} from "../src/rollout.js";

const roots = [];

function fixture() {
  const root = mkdtempSync(path.join(os.tmpdir(), "platform-upgrader-rollout-"));
  roots.push(root);
  return root;
}

function repository(fleetRoot, name, sha) {
  const repoRoot = path.join(fleetRoot, name);
  const gitDir = path.join(repoRoot, ".git");
  mkdirSync(path.join(gitDir, "refs", "heads"), { recursive: true });
  writeFileSync(path.join(gitDir, "HEAD"), "ref: refs/heads/main\n");
  writeFileSync(path.join(gitDir, "refs", "heads", "main"), `${sha}\n`);
  writeFileSync(
    path.join(repoRoot, "package.json"),
    `${JSON.stringify(
      {
        name,
        packageManager: "bun@1.4.0",
        scripts: { ci: "bun test" },
        devDependencies: { typescript: "1.0.0" },
      },
      null,
      2,
    )}\n`,
  );
  return repoRoot;
}

function lifecycleManifest(fleetRoot, repositories) {
  const manifestPath = path.join(fleetRoot, "lifecycle.json");
  writeFileSync(
    manifestPath,
    `${JSON.stringify({ schemaVersion: 1, repositories }, null, 2)}\n`,
    "utf8",
  );
  return manifestPath;
}

afterEach(() => {
  while (roots.length > 0) rmSync(roots.pop(), { recursive: true, force: true });
});

describe("boring foundation rollout report", () => {
  test("records the audited revision, stack, proposal, and repository-owned validation command", () => {
    const fleet = fixture();
    const sha = "1".repeat(40);
    const repoRoot = repository(fleet, "alpha", sha);

    expect(repositoryGitState(repoRoot)?.defaultBranchSha).toBe(sha);

    const report = buildBoringFoundationRolloutReport(fleet);
    const record = report.repositories[0];

    expect(report.schemaVersion).toBe(1);
    expect(record.auditedRevision).toBe(sha);
    expect(record.stack).toEqual(["bun", "typescript"]);
    expect(record.safeToApply).toBe(true);
    expect(record.automaticMutationAllowed).toBe(true);
    expect(record.lifecycle).toEqual({ status: "maintained", reason: null, source: "default" });
    expect(record.proposedChanges.length).toBeGreaterThan(0);
    expect(record.validation.command).toBe("bun run ci");
    expect(record.finalStatus).toBe("planned");
  });

  test("resumes an accepted repository only while the audited revision is unchanged", () => {
    const fleet = fixture();
    const reportPath = path.join(fleet, "rollout.json");
    const firstSha = "2".repeat(40);
    const secondSha = "3".repeat(40);
    const repoRoot = repository(fleet, "alpha", firstSha);

    writeRolloutReport(reportPath, buildBoringFoundationRolloutReport(fleet));
    recordRolloutResult(reportPath, "alpha", {
      finalStatus: "accepted",
      commitSha: "4".repeat(40),
      prNumber: 12,
      validationCommand: "bun run ci",
      validationStatus: "green",
    });

    const resumed = buildBoringFoundationRolloutReport(fleet, {
      existingReportPath: reportPath,
    });
    expect(resumed.repositories[0].finalStatus).toBe("accepted");
    expect(resumed.repositories[0].resumed).toBe(true);

    writeFileSync(path.join(repoRoot, ".git", "refs", "heads", "main"), `${secondSha}\n`);
    const moved = buildBoringFoundationRolloutReport(fleet, {
      existingReportPath: reportPath,
    });
    expect(moved.repositories[0].auditedRevision).toBe(secondSha);
    expect(moved.repositories[0].finalStatus).toBe("planned");
    expect(moved.repositories[0].resumed).toBe(false);
  });

  test("keeps inactive repositories audited but terminally skipped until explicit reactivation", () => {
    const fleet = fixture();
    const reportPath = path.join(fleet, "rollout.json");
    repository(fleet, "alpha", "6".repeat(40));
    const lifecyclePath = lifecycleManifest(fleet, {
      alpha: { status: "retired", reason: "superseded by the maintained template" },
    });

    const skipped = buildBoringFoundationRolloutReport(fleet, { lifecyclePath });
    const record = skipped.repositories[0];
    expect(record.safeToApply).toBe(true);
    expect(record.proposedChanges.length).toBeGreaterThan(0);
    expect(record.lifecycle).toEqual({
      status: "retired",
      reason: "superseded by the maintained template",
      source: "manifest",
    });
    expect(record.automaticMutationAllowed).toBe(false);
    expect(record.finalStatus).toBe("skipped");

    writeRolloutReport(reportPath, skipped);
    expect(() =>
      recordRolloutResult(reportPath, "alpha", {
        finalStatus: "accepted",
        validationStatus: "green",
      }),
    ).toThrow("explicit maintained lifecycle status");

    const resumed = buildBoringFoundationRolloutReport(fleet, {
      existingReportPath: reportPath,
    });
    expect(resumed.repositories[0].finalStatus).toBe("skipped");
    expect(resumed.repositories[0].lifecycle.status).toBe("retired");
    expect(resumed.repositories[0].automaticMutationAllowed).toBe(false);
    expect(resumed.repositories[0].resumed).toBe(true);

    lifecycleManifest(fleet, {
      alpha: { status: "maintained", reason: "reactivated for active development" },
    });
    const reactivated = buildBoringFoundationRolloutReport(fleet, {
      existingReportPath: reportPath,
      lifecyclePath,
    });
    expect(reactivated.repositories[0].lifecycle.status).toBe("maintained");
    expect(reactivated.repositories[0].automaticMutationAllowed).toBe(true);
    expect(reactivated.repositories[0].finalStatus).toBe("planned");
    expect(reactivated.repositories[0].resumed).toBe(false);
  });

  test("rejects lifecycle manifests that cannot safely classify inactive repositories", () => {
    const fleet = fixture();
    repository(fleet, "alpha", "7".repeat(40));
    const lifecyclePath = lifecycleManifest(fleet, {
      alpha: { status: "archived" },
    });

    expect(() => buildBoringFoundationRolloutReport(fleet, { lifecyclePath })).toThrow(
      "requires a reason when status is archived",
    );
  });

  test("refuses to mark a rollout accepted without green validation", () => {
    const fleet = fixture();
    const reportPath = path.join(fleet, "rollout.json");
    repository(fleet, "alpha", "5".repeat(40));
    writeRolloutReport(reportPath, buildBoringFoundationRolloutReport(fleet));

    expect(() =>
      recordRolloutResult(reportPath, "alpha", {
        finalStatus: "accepted",
        validationStatus: "failed",
      }),
    ).toThrow("requires green repository-native validation");

    expect(JSON.parse(readFileSync(reportPath, "utf8")).repositories[0].finalStatus).toBe(
      "planned",
    );
  });
});