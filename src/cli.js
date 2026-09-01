#!/usr/bin/env node

import { existsSync } from "node:fs";
import path from "node:path";
import process from "node:process";

import { applyEnvironmentV1, auditEnvironmentV1 } from "./environment.js";
import { applyScaffoldV2, auditRepo } from "./index.js";
import {
  clearCompatibilityHold,
  recordCompatibilityHold,
  refreshLatestStable,
} from "./refresh.js";

function resolveRepoRoot(inputPath) {
  return path.resolve(process.cwd(), inputPath ?? ".");
}

const args = process.argv.slice(2);
const [command, first, second] = args;

if (command === "audit") {
  const repoRoot = resolveRepoRoot(first);
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
  const repoRoot = resolveRepoRoot(second);
  let result;
  if (first === "scaffold-v2") {
    result = applyScaffoldV2(repoRoot);
  } else if (first === "environment-v1") {
    result = applyEnvironmentV1(repoRoot);
  } else {
    console.error('Supported migrations are "scaffold-v2" and "environment-v1".');
    process.exit(1);
  }
  console.log(JSON.stringify(result, null, 2));
  process.exit(result.audit && !result.audit.ok ? 1 : 0);
}

if (command === "refresh" && first === "latest-stable") {
  const result = await refreshLatestStable(resolveRepoRoot(second));
  console.log(JSON.stringify(result, null, 2));
  process.exit(0);
}

if (command === "hold" && first === "record") {
  const [, , tool, candidate, testedRevision, reason, inputPath] = args;
  if (!tool || !candidate || !testedRevision || !reason) {
    console.error("Usage: platform-upgrader hold record <tool> <candidate> <tested-revision> <reason> [path]");
    process.exit(1);
  }
  const result = recordCompatibilityHold(resolveRepoRoot(inputPath), {
    tool,
    candidate,
    testedRevision,
    reason,
  });
  console.log(JSON.stringify(result, null, 2));
  process.exit(0);
}

if (command === "hold" && first === "clear") {
  const [, , tool, inputPath] = args;
  if (!tool) {
    console.error("Usage: platform-upgrader hold clear <tool> [path]");
    process.exit(1);
  }
  console.log(JSON.stringify(clearCompatibilityHold(resolveRepoRoot(inputPath), tool), null, 2));
  process.exit(0);
}

console.error(
  "Usage: platform-upgrader <audit [path] | apply <scaffold-v2|environment-v1> [path] | refresh latest-stable [path] | hold <record|clear> ...>",
);
process.exit(1);
