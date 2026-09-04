import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  statSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";

import { BORING_FOUNDATION_VERSION } from "./foundation.js";
import { auditBoringFoundationV1 } from "./foundation-authority.js";

export const ROLLOUT_REPORT_SCHEMA_VERSION = 1;
export const ROLLOUT_LIFECYCLE_SCHEMA_VERSION = 1;

const LIFECYCLE_STATUSES = new Set(["maintained", "archived", "retired", "historical"]);

function readText(filePath) {
  return readFileSync(filePath, "utf8");
}

function readJson(filePath) {
  try {
    return JSON.parse(readText(filePath));
  } catch {
    return null;
  }
}

function gitDirectory(repoRoot) {
  const dotGit = path.join(repoRoot, ".git");
  if (!existsSync(dotGit)) return null;
  if (statSync(dotGit).isDirectory()) return dotGit;

  const match = readText(dotGit).trim().match(/^gitdir:\s*(.+)$/);
  return match ? path.resolve(repoRoot, match[1]) : null;
}

function packedRef(gitDir, refName) {
  const packedRefs = path.join(gitDir, "packed-refs");
  if (!existsSync(packedRefs)) return null;
  for (const line of readText(packedRefs).split(/\r?\n/)) {
    if (!line || line.startsWith("#") || line.startsWith("^")) continue;
    const [sha, name] = line.trim().split(/\s+/, 2);
    if (name === refName && /^[0-9a-f]{40}$/i.test(sha)) return sha;
  }
  return null;
}

function resolveGitRef(gitDir, refName, depth = 0) {
  if (depth > 4) return null;
  const refPath = path.join(gitDir, ...refName.split("/"));
  if (existsSync(refPath)) {
    const value = readText(refPath).trim();
    if (/^[0-9a-f]{40}$/i.test(value)) return value;
    const symbolic = value.match(/^ref:\s*(.+)$/);
    if (symbolic) return resolveGitRef(gitDir, symbolic[1], depth + 1);
  }
  return packedRef(gitDir, refName);
}

function symbolicRef(gitDir, relativePath) {
  const filePath = path.join(gitDir, ...relativePath.split("/"));
  if (!existsSync(filePath)) return null;
  return readText(filePath).trim().match(/^ref:\s*(.+)$/)?.[1] ?? null;
}

export function repositoryGitState(repoRoot) {
  const gitDir = gitDirectory(repoRoot);
  if (!gitDir) return null;

  const head = readText(path.join(gitDir, "HEAD")).trim();
  const checkedOutRef = head.match(/^ref:\s*(.+)$/)?.[1] ?? null;
  const checkedOutSha = checkedOutRef
    ? resolveGitRef(gitDir, checkedOutRef)
    : /^[0-9a-f]{40}$/i.test(head)
      ? head
      : null;

  const originHeadRef = symbolicRef(gitDir, "refs/remotes/origin/HEAD");
  const defaultBranchRef = originHeadRef ?? checkedOutRef;
  const defaultBranchSha = defaultBranchRef
    ? resolveGitRef(gitDir, defaultBranchRef) ?? checkedOutSha
    : checkedOutSha;

  return {
    checkedOutRef,
    checkedOutSha,
    defaultBranchRef,
    defaultBranch:
      defaultBranchRef?.replace(/^refs\/(?:heads|remotes\/origin)\//, "") ?? null,
    defaultBranchSha,
  };
}

function packageData(repoRoot) {
  const packagePath = path.join(repoRoot, "package.json");
  return existsSync(packagePath) ? readJson(packagePath) : null;
}

export function detectRepositoryStack(repoRoot) {
  const stack = new Set();
  const packageJson = packageData(repoRoot);
  if (packageJson) {
    const packageManager =
      typeof packageJson.packageManager === "string" ? packageJson.packageManager : "";
    stack.add(packageManager.startsWith("bun@") ? "bun" : "node");
    const dependencies = {
      ...(packageJson.dependencies ?? {}),
      ...(packageJson.devDependencies ?? {}),
    };
    if (existsSync(path.join(repoRoot, "tsconfig.json")) || dependencies.typescript)
      stack.add("typescript");
    if (dependencies.react) stack.add("react");
    if (dependencies.next) stack.add("nextjs");
    if (dependencies.vite) stack.add("vite");
  }
  if (existsSync(path.join(repoRoot, "Cargo.toml"))) stack.add("rust");
  if (existsSync(path.join(repoRoot, "src-tauri", "Cargo.toml"))) stack.add("tauri");

  try {
    const rootFiles = readdirSync(repoRoot);
    if (rootFiles.some((name) => /\.(?:sln|csproj)$/i.test(name))) stack.add("dotnet");
  } catch {
    // Repository discovery already established that this path exists. If its
    // root cannot be read, the audit below will expose the relevant conflict.
  }

  return [...stack].sort();
}

function packageValidationCommand(repoRoot, packageJson) {
  if (!packageJson?.scripts || typeof packageJson.scripts !== "object") return null;
  const script = ["ci", "verify", "check", "test"].find(
    (candidate) => typeof packageJson.scripts[candidate] === "string",
  );
  if (!script) return null;

  const packageManager =
    typeof packageJson.packageManager === "string" ? packageJson.packageManager : "";
  if (packageManager.startsWith("bun@")) return `bun run ${script}`;
  if (packageManager.startsWith("pnpm@")) return `pnpm run ${script}`;
  if (packageManager.startsWith("yarn@")) return `yarn ${script}`;
  return `npm run ${script}`;
}

export function repositoryValidationCommand(repoRoot) {
  const packageJson = packageData(repoRoot);
  const packageCommand = packageValidationCommand(repoRoot, packageJson);
  if (packageCommand) return { command: packageCommand, source: "package-script" };
  if (existsSync(path.join(repoRoot, "Cargo.toml"))) {
    return { command: "cargo test --locked", source: "cargo" };
  }
  return { command: null, source: "unresolved" };
}

function repositoryDirectories(fleetRoot) {
  return readdirSync(fleetRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => path.join(fleetRoot, entry.name))
    .filter((repoRoot) => existsSync(path.join(repoRoot, ".git")))
    .sort();
}

function previousRecords(existingReportPath) {
  if (!existingReportPath || !existsSync(existingReportPath)) return new Map();
  const report = readJson(existingReportPath);
  if (
    !report ||
    report.schemaVersion !== ROLLOUT_REPORT_SCHEMA_VERSION ||
    report.migration !== BORING_FOUNDATION_VERSION ||
    !Array.isArray(report.repositories)
  ) {
    throw new Error("Existing rollout report is not a compatible boring-foundation-v1 report");
  }
  return new Map(report.repositories.map((entry) => [entry.name, entry]));
}

function lifecycleRecords(lifecyclePath) {
  if (!lifecyclePath) return new Map();
  const resolved = path.resolve(lifecyclePath);
  const manifest = readJson(resolved);
  if (
    !manifest ||
    manifest.schemaVersion !== ROLLOUT_LIFECYCLE_SCHEMA_VERSION ||
    !manifest.repositories ||
    typeof manifest.repositories !== "object" ||
    Array.isArray(manifest.repositories)
  ) {
    throw new Error("Lifecycle manifest is not a compatible rollout lifecycle manifest");
  }

  const records = new Map();
  for (const [name, entry] of Object.entries(manifest.repositories)) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      throw new Error(`Lifecycle entry for ${name} must be an object`);
    }
    if (!LIFECYCLE_STATUSES.has(entry.status)) {
      throw new Error(`Lifecycle entry for ${name} has unsupported status ${String(entry.status)}`);
    }
    const inactive = entry.status !== "maintained";
    if (inactive && (typeof entry.reason !== "string" || entry.reason.trim().length === 0)) {
      throw new Error(`Lifecycle entry for ${name} requires a reason when status is ${entry.status}`);
    }
    records.set(name, {
      status: entry.status,
      reason: typeof entry.reason === "string" && entry.reason.trim() ? entry.reason.trim() : null,
      source: "manifest",
    });
  }
  return records;
}

function repositoryLifecycle(repoName, lifecycle) {
  return (
    lifecycle.get(repoName) ?? {
      status: "maintained",
      reason: null,
      source: "default",
    }
  );
}

function auditRepository(repoRoot, codingToolingRoot, lifecycle) {
  const audit = auditBoringFoundationV1(repoRoot, { codingToolingRoot });
  const git = repositoryGitState(repoRoot);
  const validation = repositoryValidationCommand(repoRoot);
  const auditedRevision = git?.defaultBranchSha ?? git?.checkedOutSha ?? null;
  const maintained = lifecycle.status === "maintained";
  const finalStatus = !maintained
    ? "skipped"
    : !git
      ? "blocked"
      : !audit.safeToApply
        ? "blocked"
        : audit.complete
          ? "complete"
          : "planned";

  return {
    name: path.basename(repoRoot),
    relativePath: path.basename(repoRoot),
    auditedRevision,
    git,
    stack: detectRepositoryStack(repoRoot),
    foundation: audit.components,
    foundationAuthority: audit.authority,
    proposedChanges: audit.pending,
    conflicts: audit.conflicts,
    safeToApply: audit.safeToApply,
    lifecycle,
    automaticMutationAllowed: maintained && Boolean(git) && audit.safeToApply,
    validation: { ...validation, status: "not-run" },
    application: { commitSha: null, prNumber: null },
    acceptedRevision: null,
    finalStatus,
    resumed: false,
  };
}

function resumeAcceptedRecord(current, previous) {
  if (
    current.lifecycle.status !== "maintained" ||
    !previous ||
    previous.finalStatus !== "accepted" ||
    !current.auditedRevision ||
    previous.acceptedRevision !== current.auditedRevision
  ) {
    return current;
  }

  return {
    ...current,
    validation: previous.validation,
    application: previous.application,
    acceptedRevision: previous.acceptedRevision,
    finalStatus: "accepted",
    resumed: true,
  };
}

function resumeSkippedRecord(current, previous) {
  if (
    current.lifecycle.source === "manifest" ||
    !previous ||
    previous.finalStatus !== "skipped" ||
    !previous.lifecycle ||
    previous.lifecycle.status === "maintained"
  ) {
    return current;
  }

  return {
    ...current,
    lifecycle: previous.lifecycle,
    automaticMutationAllowed: false,
    finalStatus: "skipped",
    resumed: true,
  };
}

function resumePreviousRecord(current, previous) {
  const skipped = resumeSkippedRecord(current, previous);
  if (skipped !== current) return skipped;
  return resumeAcceptedRecord(current, previous);
}

export function buildBoringFoundationRolloutReport(
  fleetRoot,
  {
    existingReportPath = null,
    repositoryNames = null,
    codingToolingRoot = null,
    lifecyclePath = null,
  } = {},
) {
  const root = path.resolve(fleetRoot);
  const previous = previousRecords(existingReportPath);
  const lifecycle = lifecycleRecords(lifecyclePath);
  const selected = repositoryNames ? new Set(repositoryNames) : null;
  const repositories = repositoryDirectories(root)
    .filter((repoRoot) => !selected || selected.has(path.basename(repoRoot)))
    .map((repoRoot) => {
      const name = path.basename(repoRoot);
      const current = auditRepository(
        repoRoot,
        codingToolingRoot,
        repositoryLifecycle(name, lifecycle),
      );
      return resumePreviousRecord(current, previous.get(current.name));
    });

  return {
    schemaVersion: ROLLOUT_REPORT_SCHEMA_VERSION,
    migration: BORING_FOUNDATION_VERSION,
    fleetRoot: root,
    codingToolingRoot: codingToolingRoot ? path.resolve(codingToolingRoot) : null,
    lifecyclePath: lifecyclePath ? path.resolve(lifecyclePath) : null,
    repositoryCount: repositories.length,
    repositories,
  };
}

export function writeRolloutReport(reportPath, report) {
  const resolved = path.resolve(reportPath);
  mkdirSync(path.dirname(resolved), { recursive: true });
  const temporary = `${resolved}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  renameSync(temporary, resolved);
  return resolved;
}

export function recordRolloutResult(
  reportPath,
  repoName,
  {
    finalStatus,
    commitSha = null,
    prNumber = null,
    validationCommand = null,
    validationStatus = null,
  },
) {
  const resolved = path.resolve(reportPath);
  const report = readJson(resolved);
  if (
    !report ||
    report.schemaVersion !== ROLLOUT_REPORT_SCHEMA_VERSION ||
    report.migration !== BORING_FOUNDATION_VERSION ||
    !Array.isArray(report.repositories)
  ) {
    throw new Error("Rollout report is not a compatible boring-foundation-v1 report");
  }

  const record = report.repositories.find((entry) => entry.name === repoName);
  if (!record) throw new Error(`Repository ${repoName} is not present in the rollout report`);

  const lifecycleStatus = record.lifecycle?.status ?? "maintained";
  if (lifecycleStatus !== "maintained" && finalStatus !== "skipped") {
    throw new Error(
      "A non-maintained rollout record must be re-planned with an explicit maintained lifecycle status before it can change rollout status",
    );
  }

  const nextValidationStatus = validationStatus ?? record.validation?.status ?? "not-run";
  if (finalStatus === "accepted" && nextValidationStatus !== "green") {
    throw new Error("An accepted rollout record requires green repository-native validation");
  }

  record.application = {
    commitSha: commitSha ?? record.application?.commitSha ?? null,
    prNumber: prNumber ?? record.application?.prNumber ?? null,
  };
  record.validation = {
    command: validationCommand ?? record.validation?.command ?? null,
    source: validationCommand ? "recorded" : record.validation?.source ?? "unresolved",
    status: nextValidationStatus,
  };
  record.finalStatus = finalStatus;
  record.acceptedRevision = finalStatus === "accepted" ? record.auditedRevision : null;
  record.resumed = false;

  writeRolloutReport(resolved, report);
  return record;
}
