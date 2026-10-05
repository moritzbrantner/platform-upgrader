import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "bun:test";

import { applyScaffoldV2, auditRepo } from "../src/index.js";

const repoRoot = path.resolve(import.meta.dir, "..");
const fixtureRepoNames = [
  "monorepo",
  "next-template",
  "expo-template",
  "electron-template",
];

describe("platform-upgrader apply scaffold-v2", () => {
  it("updates fixture repos deterministically and remains idempotent", async () => {
    const tempRoot = await mkdtemp(path.join(os.tmpdir(), "platform-upgrader-"));

    try {
      for (const repoName of fixtureRepoNames) {
        const sourceRoot = path.join(repoRoot, "tests", "fixtures", repoName);
        const targetRoot = path.join(tempRoot, repoName);
        await cp(sourceRoot, targetRoot, { recursive: true });

        const firstRun = applyScaffoldV2(targetRoot);
        const secondRun = applyScaffoldV2(targetRoot);

        expect(firstRun.changed.length).toBeGreaterThan(0);
        expect(secondRun.changed).toEqual([]);

        if (repoName !== "monorepo") {
          const manifest = await readFile(path.join(targetRoot, "app.manifest.ts"), "utf8");
          expect(manifest).toContain("entryWorkspace: '.'");
        }
      }

      expect(
        existsSync(path.join(tempRoot, "monorepo", "SCAFFOLD_V2.md")),
      ).toBe(true);
      expect(
        existsSync(
          path.join(tempRoot, "expo-template", "e2e", "smoke-auth-contract.spec.ts"),
        ),
      ).toBe(true);
      expect(
        existsSync(
          path.join(tempRoot, "electron-template", "e2e", "desktop-smoke.e2e.ts"),
        ),
      ).toBe(true);
      expect(
        existsSync(
          path.join(tempRoot, "electron-template", "scripts", "dispatch-monorepo-update.mjs"),
        ),
      ).toBe(false);

      const streamlinedWorkflows = [
        ["monorepo", "main.yml"],
        ["expo-template", "validate.yml"],
        ["electron-template", "ci.yml"],
        ["next-template", "beta-tier.yml"],
        ["next-template", "main-tier.yml"],
        ["next-template", "nightly-tier.yml"],
      ];
      for (const [repoName, workflowName] of streamlinedWorkflows) {
        const workflow = await readFile(
          path.join(tempRoot, repoName, ".github", "workflows", workflowName),
          "utf8",
        );
        expect(workflow).toContain(
          "fast-validation.yml@main",
        );
        expect(workflow).not.toContain("validate-repo.yml");
        expect(workflow).not.toContain("GH_PACKAGES_TOKEN");
        expect(workflow).not.toContain("node_auth_token");
      }

      for (const repoName of ["monorepo", "next-template", "expo-template", "electron-template"]) {
        const config = JSON.parse(await readFile(path.join(tempRoot, repoName, ".platform-upgrader.json"), "utf8"));
        expect(config.workflowMode).toBe("current-reusable");
      }
      const snapshotWorkflow = await readFile(
        path.join(tempRoot, "monorepo", ".github", "workflows", "snapshot-stage.yml"),
        "utf8",
      );
      expect(snapshotWorkflow).toContain("@main");
      expect(existsSync(path.join(tempRoot, "monorepo", ".github", "workflows", "release.yml"))).toBe(false);

      for (const [repoName, workflowName] of [
        ["monorepo", "main.yml"],
        ["expo-template", "validate.yml"],
        ["electron-template", "ci.yml"],
      ]) {
        const workflow = await readFile(
          path.join(tempRoot, repoName, ".github", "workflows", workflowName),
          "utf8",
        );
        expect(workflow).toContain("branches: [main]");
        expect(workflow).toContain("workflow_dispatch:");
        expect(workflow).toContain("github.event_name == 'pull_request'");
      }
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });
});

describe("platform-upgrader audit", () => {
  it("passes against migrated fixture repos without mutating them", async () => {
    const tempRoot = await mkdtemp(path.join(os.tmpdir(), "platform-upgrader-audit-"));

    try {
      for (const repoName of fixtureRepoNames) {
        const sourceRoot = path.join(repoRoot, "tests", "fixtures", repoName);
        const targetRoot = path.join(tempRoot, repoName);
        await cp(sourceRoot, targetRoot, { recursive: true });
        applyScaffoldV2(targetRoot);

        const result = auditRepo(targetRoot);
        expect(result.ok).toBe(true);
        expect(result.issues).toEqual([]);
      }
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  it("flags release callers of the shared release template and keeps custom release workflows", async () => {
    const tempRoot = await mkdtemp(path.join(os.tmpdir(), "platform-upgrader-release-audit-"));
    try {
      const targetRoot = path.join(tempRoot, "expo-template");
      await cp(path.join(repoRoot, "tests", "fixtures", "expo-template"), targetRoot, { recursive: true });
      applyScaffoldV2(targetRoot);
      const releasePath = path.join(targetRoot, ".github", "workflows", "release.yml");
      await writeFile(
        releasePath,
        "jobs:\n  release:\n    uses: moritzbrantner/reusable-workflows/.github/workflows/release-template.yml@main\n",
      );
      expect(auditRepo(targetRoot).issues).toContain(
        "release.yml still calls the shared release template; npm publishing is retired",
      );
      expect(applyScaffoldV2(targetRoot).changed).toEqual([".github/workflows/release.yml"]);
      expect(existsSync(releasePath)).toBe(false);

      const customRelease = "jobs:\n  release:\n    runs-on: ubuntu-latest\n    steps:\n      - run: bun run build\n";
      await writeFile(releasePath, customRelease);
      expect(applyScaffoldV2(targetRoot).changed).toEqual([]);
      expect(await readFile(releasePath, "utf8")).toBe(customRelease);
      expect(auditRepo(targetRoot).issues).toEqual([]);
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  it("rejects workflow refs that only start with main", async () => {
    const tempRoot = await mkdtemp(path.join(os.tmpdir(), "platform-upgrader-ref-audit-"));
    try {
      const targetRoot = path.join(tempRoot, "expo-template");
      await cp(path.join(repoRoot, "tests", "fixtures", "expo-template"), targetRoot, { recursive: true });
      applyScaffoldV2(targetRoot);
      const workflowPath = path.join(targetRoot, ".github", "workflows", "validate.yml");
      const workflow = await readFile(workflowPath, "utf8");
      await writeFile(workflowPath, workflow.replace("fast-validation.yml@main", "fast-validation.yml@main-frozen"));
      expect(auditRepo(targetRoot).issues).toContain("expo-template validate workflow is not using current reusable workflows");
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });
});
