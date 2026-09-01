#!/usr/bin/env node

import { existsSync } from "node:fs";
import path from "node:path";
import process from "node:process";

import { applyEnvironmentV1, auditEnvironmentV1 } from "./environment.js";
import { applyScaffoldV2, auditRepo } from "./index.js";

function resolveRepoRoot(inputPath) {
  return path.resolve(process.cwd(), inputPath ?? ".");
}

const [command, migrationOrPath, maybePath] = process.argv.slice(2);

if (command === "audit") {
  const repoRoot = resolveRepoRoot(migrationOrPath);
  const environment = auditEnvironmentV1(repoRoot);
  const hasScaffoldConfig = existsSync(path.join(repoRoot, ".platform-upgrader.json"));
  const scaffold = hasScaffoldConfig ? auditRepo(repoRoot) : null;
  const issues = [...(scaffold?.issues ?? []), ...environment.issues];
  const result = {
    repoName: path.basename(repoRoot),
    config: scaffold?.config ?? null,
    scaffold,
    environment,
    issues,
    ok: issues.length === 0,
  };
  console.log(JSON.stringify(result, null, 2));
  process.exit(result.ok ? 0 : 1);
}

if (command === "apply") {
  const repoRoot = resolveRepoRoot(maybePath);
  let result;
  if (migrationOrPath === "scaffold-v2") {
    result = applyScaffoldV2(repoRoot);
  } else if (migrationOrPath === "environment-v1") {
    result = applyEnvironmentV1(repoRoot);
  } else {
    console.error('Supported migrations are "scaffold-v2" and "environment-v1".');
    process.exit(1);
  }
  console.log(JSON.stringify(result, null, 2));
  process.exit(result.audit && !result.audit.ok ? 1 : 0);
}

console.error(
  "Usage: platform-upgrader <audit [path] | apply <scaffold-v2|environment-v1> [path]>",
);
process.exit(1);
