#!/usr/bin/env node

import path from "node:path";
import process from "node:process";

import { applyScaffoldV2, auditRepo } from "./index.js";

function resolveRepoRoot(inputPath) {
  return path.resolve(process.cwd(), inputPath ?? ".");
}

const [command, migrationOrPath, maybePath] = process.argv.slice(2);

if (command === "audit") {
  const repoRoot = resolveRepoRoot(migrationOrPath);
  const result = auditRepo(repoRoot);
  console.log(JSON.stringify(result, null, 2));
  process.exit(result.ok ? 0 : 1);
}

if (command === "apply") {
  if (migrationOrPath !== "scaffold-v2") {
    console.error('Only "apply scaffold-v2" is supported.');
    process.exit(1);
  }

  const repoRoot = resolveRepoRoot(maybePath);
  const result = applyScaffoldV2(repoRoot);
  console.log(JSON.stringify(result, null, 2));
  process.exit(0);
}

console.error("Usage: platform-upgrader <audit [path] | apply scaffold-v2 [path]>");
process.exit(1);
