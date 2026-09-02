import { spawnSync } from "node:child_process";
import path from "node:path";
import process from "node:process";

import { describe, expect, test } from "bun:test";

const cli = path.resolve(import.meta.dir, "../src/cli.js");

function runCli(...args) {
  return spawnSync(process.execPath, [cli, ...args], {
    encoding: "utf8",
  });
}

describe("platform-upgrader CLI", () => {
  test("prints usage and fails when no command is supplied", () => {
    const result = runCli();

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Usage: platform-upgrader");
  });

  test("rejects an unsupported migration at the CLI boundary", () => {
    const result = runCli("apply", "unsupported-migration");

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('Supported migrations are "scaffold-v2" and "environment-v1".');
  });
});
