import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { spawnSync } from "node:child_process";

import { afterEach, describe, expect, test } from "bun:test";

const cli = path.resolve(import.meta.dir, "../src/cli.js");
const roots = [];

function runCli(...args) {
  return spawnSync(process.execPath, [cli, ...args], {
    encoding: "utf8",
  });
}

function fixture() {
  const root = mkdtempSync(path.join(os.tmpdir(), "platform-upgrader-cli-"));
  roots.push(root);
  return root;
}

afterEach(() => {
  while (roots.length > 0) rmSync(roots.pop(), { recursive: true, force: true });
});

describe("platform-upgrader CLI", () => {
  test("prints usage and fails when no command is supplied", () => {
    const result = runCli();

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Usage: platform-upgrader");
  });

  test("rejects an unsupported migration at the CLI boundary", () => {
    const result = runCli("apply", "unsupported-migration");

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      'Supported migrations are "scaffold-v2", "environment-v1", and "boring-foundation-v1".',
    );
  });

  test("audits and applies the boring foundation without requiring a package manager", () => {
    const root = fixture();

    const before = runCli("audit", "boring-foundation-v1", root);
    expect(before.status).toBe(0);
    expect(JSON.parse(before.stdout).migration).toBe("boring-foundation-v1");

    const applied = runCli("apply", "boring-foundation-v1", root);
    expect(applied.status).toBe(0);
    const result = JSON.parse(applied.stdout);
    expect(result.changed).toContain("renovate.json");
    expect(result.audit.components.conventions.status).toBe("delegated");
  });
});
