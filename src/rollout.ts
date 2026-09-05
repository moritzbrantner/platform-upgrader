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

import { auditBoringFoundationV1 } from "./foundation-authority.js";
import { BORING_FOUNDATION_VERSION } from "./foundation.js";

export const ROLLOUT_REPORT_SCHEMA_VERSION = 1;
export const ROLLOUT_LIFECYCLE_SCHEMA_VERSION = 1;

type JsonObject = Record<string, unknown>;
type LifecycleStatus = "maintained" | "archived" | "retired" | "historical";
type Lifecycle = {
  status: LifecycleStatus;
  reason: string | null;
  source: "manifest" | "default";
};
type GitState = {
  checkedOutRef: string | null;
  checkedOutSha: string | null;
  defaultBranchRef: string | null;
  defaultBranch: string | null;
  defaultBranchSha: string | null;
};
type Validation = {
  command: string | null;
  source: string;
  status: string;
};
type Application = {
  commitSha: string | null;
  prNumber: number | null;
};
type RolloutRecord = JsonObject & {
  name: string;
  auditedRevision: string | null;
  lifecycle: Lifecycle;
  validation: Validation;
  application: Application;
  acceptedRevision: string | null;
  finalStatus: string;
  resumed: boolean;
  automaticMutationAllowed: boolean;
};
type RolloutReport = JsonObject & {
  schemaVersion: number;
  migration: string;
  repositories: RolloutRecord[];
};
type BuildReportOptions = {
  existingReportPath?: string | null;
  repositoryNames?: string[] | null;
  codingToolingRoot?: string | null;
  lifecyclePath?: string | null;
};
type RecordResultOptions = {
  finalStatus: string;
  commitSha?: string | null;
  prNumber?: number | null;
  validationCommand?: string | null;
  validationStatus?: string | null;
};

const LIFECYCLE_STATUSES = new Set<LifecycleStatus>([
  "maintained",
  "archived",
  "retired",
  "historical",
]);

function isRecord(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readText(filePath: string): string {
  return readFileSync(filePath, "utf8");
}

function readJson(filePath: string): unknown {
  try {
    return JSON.parse(readText(filePath)) as unknown;
  } catch {
    return null;
  }
}

function gitDirectory(repoRoot: string): string | null {
  const dotGit = path.join(repoRoot, ".git");
  if (!existsSync(dotGit)) {
    return null;
  }
  if (statSync(dotGit).isDirectory()) {
    return dotGit;
  }

  const match = readText(dotGit)
    .trim()
    .match(/^gitdir:\s*(.+)$/);
  const relative = match?.[1];
  return relative ? path.resolve(repoRoot, relative) : null;
}

function packedRef(gitDir: string, refName: string): string | null {
  const packedRefs = path.join(gitDir, "packed-refs");
  if (!existsSync(packedRefs)) {
    return null;
  }
  for (const line of readText(packedRefs).split(/\r?\n/)) {
    if (!line || line.startsWith("#") || line.startsWith("^")) {
      continue;
    }
    const [sha, name] = line.trim().split(/\s+/, 2);
    if (name === refName && sha && /^[0-9a-f]{40}$/i.test(sha)) {
      return sha;
    }
  }
  return null;
}

function resolveGitRef(gitDir: string, refName: string, depth = 0): string | null {
  if (depth > 4) {
    return null;
  }
  const refPath = path.join(gitDir, ...refName.split("/"));
  if (existsSync(refPath)) {
    const value = readText(refPath).trim();
    if (/^[0-9a-f]{40}$/i.test(value)) {
      return value;
    }
    const symbolic = value.match(/^ref:\s*(.+)$/)?.[1];
    if (symbolic) {
      return resolveGitRef(gitDir, symbolic, depth + 1);
    }
  }
  return packedRef(gitDir, refName);
}

function symbolicRef(gitDir: string, relativePath: string): string | null {
  const filePath = path.join(gitDir, ...relativePath.split("/"));
  if (!existsSync(filePath)) {
    return null;
  }
  return (
    readText(filePath)
      .trim()
      .match(/^ref:\s*(.+)$/)?.[1] ?? null
  );
}

export function repositoryGitState(repoRoot: string): GitState | null {
  const gitDir = gitDirectory(repoRoot);
  if (!gitDir) {
    return null;
  }

  const head = readText(path.join(gitDir, "HEAD")).trim();
  const checkedOutRef = head.match(/^ref:\s*(.+)$/)?.[1] ?? null;
  let checkedOutSha: string | null = null;
  if (checkedOutRef) {
    checkedOutSha = resolveGitRef(gitDir, checkedOutRef);
  } else if (/^[0-9a-f]{40}$/i.test(head)) {
    checkedOutSha = head;
  }

  const originHeadRef = symbolicRef(gitDir, "refs/remotes/origin/HEAD");
  const defaultBranchRef = originHeadRef ?? checkedOutRef;
  const defaultBranchSha = defaultBranchRef
    ? (resolveGitRef(gitDir, defaultBranchRef) ?? checkedOutSha)
    : checkedOutSha;

  return {
    checkedOutRef,
    checkedOutSha,
    defaultBranchRef,
    defaultBranch: defaultBranchRef?.replace(/^refs\/(?:heads|remotes\/origin)\//, "") ?? null,
    defaultBranchSha,
  };
}

function packageData(repoRoot: string): JsonObject | null {
  const packagePath = path.join(repoRoot, "package.json");
  if (!existsSync(packagePath)) {
    return null;
  }
  const parsed = readJson(packagePath);
  return isRecord(parsed) ? parsed : null;
}

function objectValue(value: unknown): JsonObject {
  return isRecord(value) ? value : {};
}

export function detectRepositoryStack(repoRoot: string): string[] {
  const stack = new Set<string>();
  const packageJson = packageData(repoRoot);
  if (packageJson) {
    const packageManager =
      typeof packageJson.packageManager === "string" ? packageJson.packageManager : "";
    stack.add(packageManager.startsWith("bun@") ? "bun" : "node");
    const dependencies = {
      ...objectValue(packageJson.dependencies),
      ...objectValue(packageJson.devDependencies),
    };
    if (existsSync(path.join(repoRoot, "tsconfig.json")) || dependencies.typescript) {
      stack.add("typescript");
    }
    if (dependencies.react) {
      stack.add("react");
    }
    if (dependencies.next) {
      stack.add("nextjs");
    }
    if (dependencies.vite) {
      stack.add("vite");
    }
  }
  if (existsSync(path.join(repoRoot, "Cargo.toml"))) {
    stack.add("rust");
  }
  if (existsSync(path.join(repoRoot, "src-tauri", "Cargo.toml"))) {
    stack.add("tauri");
  }

  try {
    const rootFiles = readdirSync(repoRoot);
    if (rootFiles.some((name) => /\.(?:sln|csproj)$/i.test(name))) {
      stack.add("dotnet");
    }
  } catch {
    // The audit below reports unreadable repository state as a blocker.
  }

  return [...stack].sort();
}

function packageValidationCommand(packageJson: JsonObject): string | null {
  const scripts = objectValue(packageJson.scripts);
  const script = ["ci", "verify", "check", "test"].find(
    (candidate) => typeof scripts[candidate] === "string",
  );
  if (!script) {
    return null;
  }

  const packageManager =
    typeof packageJson.packageManager === "string" ? packageJson.packageManager : "";
  if (packageManager.startsWith("bun@")) {
    return `bun run ${script}`;
  }
  if (packageManager.startsWith("pnpm@")) {
    return `pnpm run ${script}`;
  }
  if (packageManager.startsWith("yarn@")) {
    return `yarn ${script}`;
  }
  return `npm run ${script}`;
}

export function repositoryValidationCommand(repoRoot: string): {
  command: string | null;
  source: string;
} {
  const packageJson = packageData(repoRoot);
  if (packageJson) {
    const packageCommand = packageValidationCommand(packageJson);
    if (packageCommand) {
      return { command: packageCommand, source: "package-script" };
    }
  }
  if (existsSync(path.join(repoRoot, "Cargo.toml"))) {
    return { command: "cargo test --locked", source: "cargo" };
  }
  return { command: null, source: "unresolved" };
}

function repositoryDirectories(fleetRoot: string): string[] {
  return readdirSync(fleetRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => path.join(fleetRoot, entry.name))
    .filter((repoRoot) => existsSync(path.join(repoRoot, ".git")))
    .sort();
}

function isRolloutRecord(value: unknown): value is RolloutRecord {
  return isRecord(value) && typeof value.name === "string";
}

function previousRecords(
  existingReportPath: string | null | undefined,
): Map<string, RolloutRecord> {
  if (!existingReportPath || !existsSync(existingReportPath)) {
    return new Map();
  }
  const report = readJson(existingReportPath);
  if (
    !isRecord(report) ||
    report.schemaVersion !== ROLLOUT_REPORT_SCHEMA_VERSION ||
    report.migration !== BORING_FOUNDATION_VERSION ||
    !Array.isArray(report.repositories) ||
    !report.repositories.every(isRolloutRecord)
  ) {
    throw new Error("Existing rollout report is not a compatible boring-foundation-v1 report");
  }
  return new Map(report.repositories.map((entry) => [entry.name, entry]));
}

function lifecycleRecords(lifecyclePath: string | null | undefined): Map<string, Lifecycle> {
  if (!lifecyclePath) {
    return new Map();
  }
  const resolved = path.resolve(lifecyclePath);
  const manifest = readJson(resolved);
  if (
    !isRecord(manifest) ||
    manifest.schemaVersion !== ROLLOUT_LIFECYCLE_SCHEMA_VERSION ||
    !isRecord(manifest.repositories)
  ) {
    throw new Error("Lifecycle manifest is not a compatible rollout lifecycle manifest");
  }

  const records = new Map<string, Lifecycle>();
  for (const [name, entry] of Object.entries(manifest.repositories)) {
    if (!isRecord(entry)) {
      throw new Error(`Lifecycle entry for ${name} must be an object`);
    }
    if (
      typeof entry.status !== "string" ||
      !LIFECYCLE_STATUSES.has(entry.status as LifecycleStatus)
    ) {
      throw new Error(`Lifecycle entry for ${name} has unsupported status ${String(entry.status)}`);
    }
    const status = entry.status as LifecycleStatus;
    const inactive = status !== "maintained";
    if (inactive && (typeof entry.reason !== "string" || entry.reason.trim().length === 0)) {
      throw new Error(`Lifecycle entry for ${name} requires a reason when status is ${status}`);
    }
    records.set(name, {
      status,
      reason: typeof entry.reason === "string" && entry.reason.trim() ? entry.reason.trim() : null,
      source: "manifest",
    });
  }
  return records;
}

function repositoryLifecycle(repoName: string, lifecycle: Map<string, Lifecycle>): Lifecycle {
  return (
    lifecycle.get(repoName) ?? {
      status: "maintained",
      reason: null,
      source: "default",
    }
  );
}

function rolloutStatus(
  maintained: boolean,
  git: GitState | null,
  safeToApply: boolean,
  complete: boolean,
): string {
  if (!maintained) {
    return "skipped";
  }
  if (!git || !safeToApply) {
    return "blocked";
  }
  return complete ? "complete" : "planned";
}

function auditRepository(
  repoRoot: string,
  codingToolingRoot: string | null | undefined,
  lifecycle: Lifecycle,
): RolloutRecord {
  const audit = auditBoringFoundationV1(repoRoot, { codingToolingRoot });
  const git = repositoryGitState(repoRoot);
  const validation = repositoryValidationCommand(repoRoot);
  const auditedRevision = git?.defaultBranchSha ?? git?.checkedOutSha ?? null;
  const maintained = lifecycle.status === "maintained";
  const finalStatus = rolloutStatus(maintained, git, audit.safeToApply, audit.complete);

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

function resumeAcceptedRecord(
  current: RolloutRecord,
  previous: RolloutRecord | undefined,
): RolloutRecord {
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

function resumeSkippedRecord(
  current: RolloutRecord,
  previous: RolloutRecord | undefined,
): RolloutRecord {
  if (
    current.lifecycle.source === "manifest" ||
    !previous ||
    previous.finalStatus !== "skipped" ||
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

function resumePreviousRecord(
  current: RolloutRecord,
  previous: RolloutRecord | undefined,
): RolloutRecord {
  const skipped = resumeSkippedRecord(current, previous);
  if (skipped !== current) {
    return skipped;
  }
  return resumeAcceptedRecord(current, previous);
}

export function buildBoringFoundationRolloutReport(
  fleetRoot: string,
  {
    existingReportPath = null,
    repositoryNames = null,
    codingToolingRoot = null,
    lifecyclePath = null,
  }: BuildReportOptions = {},
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

export function writeRolloutReport(reportPath: string, report: unknown): string {
  const resolved = path.resolve(reportPath);
  mkdirSync(path.dirname(resolved), { recursive: true });
  const temporary = `${resolved}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  renameSync(temporary, resolved);
  return resolved;
}

function parseRolloutReport(reportPath: string): RolloutReport {
  const report = readJson(reportPath);
  if (
    !isRecord(report) ||
    report.schemaVersion !== ROLLOUT_REPORT_SCHEMA_VERSION ||
    report.migration !== BORING_FOUNDATION_VERSION ||
    !Array.isArray(report.repositories) ||
    !report.repositories.every(isRolloutRecord)
  ) {
    throw new Error("Rollout report is not a compatible boring-foundation-v1 report");
  }
  return report as RolloutReport;
}

export function recordRolloutResult(
  reportPath: string,
  repoName: string,
  {
    finalStatus,
    commitSha = null,
    prNumber = null,
    validationCommand = null,
    validationStatus = null,
  }: RecordResultOptions,
): RolloutRecord {
  const resolved = path.resolve(reportPath);
  const report = parseRolloutReport(resolved);
  const record = report.repositories.find((entry) => entry.name === repoName);
  if (!record) {
    throw new Error(`Repository ${repoName} is not present in the rollout report`);
  }

  if (record.lifecycle.status !== "maintained" && finalStatus !== "skipped") {
    throw new Error(
      "A non-maintained rollout record must be re-planned with an explicit maintained lifecycle status before it can change rollout status",
    );
  }

  const nextValidationStatus = validationStatus ?? record.validation.status ?? "not-run";
  if (finalStatus === "accepted" && nextValidationStatus !== "green") {
    throw new Error("An accepted rollout record requires green repository-native validation");
  }

  record.application = {
    commitSha: commitSha ?? record.application.commitSha ?? null,
    prNumber: prNumber ?? record.application.prNumber ?? null,
  };
  record.validation = {
    command: validationCommand ?? record.validation.command ?? null,
    source: validationCommand ? "recorded" : (record.validation.source ?? "unresolved"),
    status: nextValidationStatus,
  };
  record.finalStatus = finalStatus;
  record.acceptedRevision = finalStatus === "accepted" ? record.auditedRevision : null;
  record.resumed = false;

  writeRolloutReport(resolved, report);
  return record;
}
