import { cp, mkdtemp, readFile, rm } from "node:fs/promises";
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
});
