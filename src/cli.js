#!/usr/bin/env node

import { existsSync } from "node:fs";
import path from "node:path";
import process from "node:process";

import { applyEnvironmentV1, auditEnvironmentV1 } from "./environment.js";
import { applyBoringFoundationV1, auditBoringFoundationV1 } from "./foundation.js";
import { applyScaffoldV2, auditRepo } from "./index.js";
import {
  clearCompatibilityHold,
  recordCompatibilityHold,
  refreshLatestStable,
} from "./refresh.js";
import {
  buildBoringFoundationRolloutReport,
  recordRolloutResult,
  writeRolloutReport,
} from "./rollout.js";

function resolveRepoRoot(inputPath) {
  return path.resolve(process.cwd(), inputPath ?? ".");
}

function optionValue(values, name) {
  const index = values.indexOf(`--${name}`);
  if (index < 0) return null;
  const value = values[index + 1];
  return value && !value.startsWith("--") ? value : null;
}

const args = process.argv.slice(2);
const [command, first, second] = args;

if (command === "rollout" && first === "plan") {
  if (second !== "boring-foundation-v1") {
    console.error('Supported rollout migration is "boring-foundation-v1".');
    process.exit(1);
  }

  const values = args.slice(3);
  const inputPath = values[0] && !values[0].startsWith("--") ? values.shift() : ".";
  const reportOption = optionValue(values, "report");
  if (!reportOption) {
    console.error(
      "Usage: platform-upgrader rollout plan boring-foundation-v1 [fleet-root] --report <path> [--repos <name,...>]",
    );
    process.exit(1);
  }
  const knownFlags = new Set(["--report", "--repos"]);
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    if (!knownFlags.has(value) || !values[index + 1] || values[index + 1].startsWith("--")) {
      console.error("Invalid rollout plan options");
      process.exit(1);
    }
    index += 1;
  }

  const reportPath = path.resolve(process.cwd(), reportOption);
  const repositoryNames = optionValue(values, "repos")
    ?.split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  try {
    const report = buildBoringFoundationRolloutReport(resolveRepoRoot(inputPath), {
      existingReportPath: reportPath,
      repositoryNames: repositoryNames?.length ? repositoryNames : null,
    });
    writeRolloutReport(reportPath, report);
    console.log(JSON.stringify(report, null, 2));
    process.exit(0);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}

if (command === "rollout" && first === "record") {
  const reportPath = second ? path.resolve(process.cwd(), second) : null;
  const repoName = args[3];
  const finalStatus = optionValue(args, "status");
  if (!reportPath || !repoName || !finalStatus) {
    console.error(
      "Usage: platform-upgrader rollout record <report> <repo> --status <status> [--commit <sha>] [--pr <number>] [--validation-command <command>] [--validation-status <green|failed|not-run>]",
    );
    process.exit(1);
  }

  const prValue = optionValue(args, "pr");
  const prNumber = prValue === null ? null : Number(prValue);
  if (prValue !== null && (!Number.isInteger(prNumber) || prNumber <= 0)) {
    console.error("--pr must be a positive integer");
    process.exit(1);
  }

  try {
    const record = recordRolloutResult(reportPath, repoName, {
      finalStatus,
      commitSha: optionValue(args, "commit"),
      prNumber,
      validationCommand: optionValue(args, "validation-command"),
      validationStatus: optionValue(args, "validation-status"),
    });
    console.log(JSON.stringify(record, null, 2));
    process.exit(0);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}

if (command === "audit") {
  if (first === "boring-foundation-v1") {
    const result = auditBoringFoundationV1(resolveRepoRoot(second));
    console.log(JSON.stringify(result, null, 2));
    process.exit(result.safeToApply ? 0 : 1);
  }

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
  } else if (first === "boring-foundation-v1") {
    result = applyBoringFoundationV1(repoRoot);
  } else {
    console.error(
      'Supported migrations are "scaffold-v2", "environment-v1", and "boring-foundation-v1".',
    );
    process.exit(1);
  }
  console.log(JSON.stringify(result, null, 2));
  if (first === "boring-foundation-v1") {
    process.exit(result.audit.safeToApply ? 0 : 1);
  }
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
  "Usage: platform-upgrader <audit [boring-foundation-v1] [path] | apply <scaffold-v2|environment-v1|boring-foundation-v1> [path] | rollout <plan|record> ... | refresh latest-stable [path] | hold <record|clear> ...>",
);
process.exit(1);
