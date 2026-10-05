#!/usr/bin/env bun

// The `prepare` script. It only acts when the package sits below node_modules, which is where
// bun places a consumer's commit-pinned git dependency (listed in `trustedDependencies`).
// bun does not install a git dependency's devDependencies (TypeScript builds dist/), so the
// build runs in a copy outside node_modules with its own install, and only the build output is
// copied back. The repository has no lockfile, so that install is not frozen.
// The dependency's own node_modules, which bun resolved for the consumer, is left untouched.
// In a normal checkout it does nothing: `bun install` and `npm pack` (npm 10 runs prepare
// despite --ignore-scripts) must stay side-effect free there.

import { execFileSync } from "node:child_process";
import { cpSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const buildOutputs = ["dist"];
const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function run(args: string[], cwd: string) {
  execFileSync("bun", args, { cwd, stdio: "inherit" });
}

if (packageRoot.split(path.sep).includes("node_modules")) {
  const buildRoot = mkdtempSync(path.join(tmpdir(), "git-install-build-"));
  const skipped = new Set(
    ["node_modules", ".git", ...buildOutputs].map((entry) => path.join(packageRoot, entry)),
  );

  try {
    cpSync(packageRoot, buildRoot, {
      recursive: true,
      filter: (source) => !skipped.has(source),
    });
    run(["install", "--ignore-scripts"], buildRoot);
    run(["run", "build"], buildRoot);

    for (const output of buildOutputs) {
      rmSync(path.join(packageRoot, output), { recursive: true, force: true });
      cpSync(path.join(buildRoot, output), path.join(packageRoot, output), { recursive: true });
    }
  } finally {
    rmSync(buildRoot, { recursive: true, force: true });
  }
}
