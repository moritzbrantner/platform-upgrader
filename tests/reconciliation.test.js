import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "bun:test";

import { applyBoringFoundationV1 } from "../src/foundation.js";
import { applyEnvironmentV1 } from "../src/environment.js";
import { applyScaffoldV2 } from "../src/index.js";

async function write(root, relative, contents) {
  const target = path.join(root, relative);
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, contents, "utf8");
}

async function textSnapshot(root) {
  const entries = [];
  async function visit(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (entry.name === ".git") continue;
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) await visit(absolute);
      else if (entry.isFile()) {
        entries.push([
          path.relative(root, absolute).split(path.sep).join("/"),
          await readFile(absolute, "utf8"),
        ]);
      }
    }
  }
  await visit(root);
  return entries.sort(([left], [right]) => left.localeCompare(right));
}

async function repository(prefix) {
  return mkdtemp(path.join(os.tmpdir(), prefix));
}

describe("migration reconciliation", () => {
  it("scaffold-v2 changes once and then performs no mutation work", async () => {
    const root = await repository("platform-reconcile-scaffold-");
    try {
      await write(
        root,
        ".platform-upgrader.json",
        `${JSON.stringify({ migrationsAccepted: ["scaffold-v2"], workflowMode: "pinned-reusable" })}\n`,
      );
      await write(
        root,
        "app.manifest.ts",
        "export default { packageName: 'example', releaseCadence: 'manual' };\n",
      );
      await write(
        root,
        "package.json",
        `${JSON.stringify({ scripts: { "sync:monorepo": "echo stale" } })}\n`,
      );

      const first = applyScaffoldV2(root);
      expect(first.changed.length).toBeGreaterThan(0);
      const accepted = await textSnapshot(root);
      const second = applyScaffoldV2(root);
      expect(second.changed).toEqual([]);
      expect(await textSnapshot(root)).toEqual(accepted);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("environment-v1 changes once and then performs no mutation work", async () => {
    const root = await repository("platform-reconcile-environment-");
    try {
      await write(root, "package.json", '{"packageManager":"bun@1.4.0"}\n');
      const first = applyEnvironmentV1(root);
      expect(first.changed.length).toBeGreaterThan(0);
      const accepted = await textSnapshot(root);
      const second = applyEnvironmentV1(root);
      expect(second.changed).toEqual([]);
      expect(await textSnapshot(root)).toEqual(accepted);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("boring-foundation-v1 converges to the same verified repository state", async () => {
    const root = await repository("platform-reconcile-foundation-");
    try {
      await write(root, "package.json", '{"packageManager":"bun@1.4.0"}\n');
      const first = applyBoringFoundationV1(root);
      expect(first.changed.length).toBeGreaterThan(0);
      const accepted = await textSnapshot(root);
      const second = applyBoringFoundationV1(root);
      expect(second.changed).toEqual([]);
      expect(await textSnapshot(root)).toEqual(accepted);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
