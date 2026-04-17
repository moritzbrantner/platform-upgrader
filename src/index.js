import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";

const PINNED_REF = "moritzbrantner/reusable-workflows/.github/workflows";
const PINNED_TAG = "scaffold-v2-initial";

function readText(filePath) {
  return readFileSync(filePath, "utf8");
}

function writeText(filePath, contents) {
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, contents, "utf8");
}

function readJson(filePath) {
  return JSON.parse(readText(filePath));
}

function writeJson(filePath, value) {
  writeText(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function ensureConfig(repoRoot) {
  const configPath = path.join(repoRoot, ".platform-upgrader.json");
  if (!existsSync(configPath)) {
    throw new Error(`Missing required config: ${configPath}`);
  }

  const config = readJson(configPath);
  if (!Array.isArray(config.migrationsAccepted) || !config.migrationsAccepted.includes("scaffold-v2")) {
    throw new Error(`${configPath} must accept scaffold-v2.`);
  }

  return config;
}

function upsertAppManifest(appManifestPath) {
  if (!existsSync(appManifestPath)) {
    return false;
  }

  let source = readText(appManifestPath);
  let changed = false;

  if (/entryWorkspace:\s*'[^']*',/.test(source)) {
    const nextSource = source.replace(/entryWorkspace:\s*'[^']*',/, "entryWorkspace: '.',");
    changed ||= nextSource !== source;
    source = nextSource;
  } else {
    const nextSource = source.replace(
      /packageName:\s*'[^']*',/,
      (match) => `${match}\n  entryWorkspace: '.',`,
    );
    changed ||= nextSource !== source;
    source = nextSource;
  }

  if (!/sharedPackages:\s*\[/.test(source)) {
    const nextSource = source.replace(
      /releaseCadence:\s*'[^']*',/,
      (match) => `${match}\n  sharedPackages: [],`,
    );
    changed ||= nextSource !== source;
    source = nextSource;
  }

  if (changed) {
    writeText(appManifestPath, source);
  }

  return changed;
}

function normalizePackageJson(packageJsonPath) {
  if (!existsSync(packageJsonPath)) {
    return false;
  }

  const pkg = readJson(packageJsonPath);
  let changed = false;

  if (pkg.scripts && pkg.scripts["sync:monorepo"]) {
    delete pkg.scripts["sync:monorepo"];
    changed = true;
  }

  if (pkg.scripts && pkg.scripts["test:e2e"] === "playwright test") {
    pkg.scripts["test:e2e"] = "playwright test e2e/smoke-auth-contract.spec.ts";
    changed = true;
  }

  if (pkg.scripts && typeof pkg.scripts["test:e2e"] === "string" && pkg.scripts["test:e2e"].includes("example.e2e.ts")) {
    pkg.scripts["test:e2e"] = pkg.scripts["test:e2e"].replace("example.e2e.ts", "desktop-smoke.e2e.ts");
    changed = true;
  }

  if (changed) {
    writeJson(packageJsonPath, pkg);
  }

  return changed;
}

function ensureMonorepoBaseline(repoRoot) {
  const filePath = path.join(repoRoot, "SCAFFOLD_V2.md");
  if (existsSync(filePath)) {
    return false;
  }

  writeText(
    filePath,
    "# SCAFFOLD_V2.md — canonical scaffold contract\n\n`scaffold-v2` is the current alignment baseline for the maintained platform family.\n",
  );
  return true;
}

function ensureUpdateGuide(repoRoot) {
  const filePath = path.join(repoRoot, "docs", "updating-from-upstream.md");
  if (!existsSync(filePath)) {
    return false;
  }

  const nextSource = `# Updating the Scaffold

This repo no longer assumes subtree sync or upstream folder merges.

## Update order

1. Adopt released runtime package updates from \`platform-packages\`.
2. Adopt pinned reusable workflow updates.
3. Apply structural repo migrations through \`@moritzbrantner/platform-upgrader\`.
`;
  if (readText(filePath) === nextSource) {
    return false;
  }

  writeText(filePath, nextSource);
  return true;
}

function renameIfExists(repoRoot, fromRelative, toRelative) {
  const fromPath = path.join(repoRoot, fromRelative);
  const toPath = path.join(repoRoot, toRelative);

  if (!existsSync(fromPath) || existsSync(toPath)) {
    return false;
  }

  mkdirSync(path.dirname(toPath), { recursive: true });
  renameSync(fromPath, toPath);
  return true;
}

function removeIfExists(repoRoot, relativePath) {
  const filePath = path.join(repoRoot, relativePath);
  if (!existsSync(filePath)) {
    return false;
  }

  rmSync(filePath, { recursive: true, force: true });
  return true;
}

function normalizeWorkflow(repoRoot, workflowName) {
  const workflowPath = path.join(repoRoot, ".github", "workflows", workflowName);
  if (!existsSync(workflowPath)) {
    return false;
  }

  let contents = "";

  if (workflowName === "validate.yml" || workflowName === "ci.yml" || workflowName === "main.yml") {
    contents = `name: ${workflowName === "main.yml" ? "Main" : workflowName === "ci.yml" ? "CI" : "Validate"}

on:
  push:
  pull_request:

jobs:
  validate:
    permissions:
      contents: read
      packages: read
    uses: ${PINNED_REF}/validate-repo.yml@${PINNED_TAG}
    with:
      test_command: bun run test
      lint_command: bun run lint
      build_command: bun run build
`;
  }

  if (workflowName === "release.yml") {
    contents = `name: Release

on:
  workflow_dispatch:

jobs:
  release:
    permissions:
      contents: read
      packages: read
    uses: ${PINNED_REF}/release-template.yml@${PINNED_TAG}
    with:
      release_type: scaffold-v2
      validate_command: bun run build
`;
  }

  if (workflowName === "snapshot-stage.yml") {
    contents = `name: Snapshot Stage

on:
  workflow_call:
    inputs:
      stage:
        required: true
        type: string
      tested_sha:
        required: true
        type: string
      promote_to:
        required: false
        type: string
        default: ""
      promote:
        required: false
        type: boolean
        default: false
    secrets:
      GH_PROMOTION_TOKEN:
        required: false

jobs:
  promote:
    if: inputs.promote && inputs.promote_to != ''
    permissions:
      contents: write
    uses: ${PINNED_REF}/promote-branches.yml@${PINNED_TAG}
    with:
      source_branch: \${{ inputs.stage }}
      target_branch: \${{ inputs.promote_to }}
      tested_sha: \${{ inputs.tested_sha }}
    secrets:
      promotion_token: \${{ secrets.GH_PROMOTION_TOKEN }}
`;
  }

  if (!contents) {
    return false;
  }

  if (readText(workflowPath) === contents) {
    return false;
  }

  writeText(workflowPath, contents);
  return true;
}

export function auditRepo(repoRoot) {
  const config = ensureConfig(repoRoot);
  const repoName = path.basename(repoRoot);
  const issues = [];

  if (config.workflowMode !== "pinned-reusable") {
    issues.push("workflowMode must be pinned-reusable");
  }

  if (repoName === "monorepo") {
    if (!existsSync(path.join(repoRoot, "SCAFFOLD_V2.md"))) {
      issues.push("SCAFFOLD_V2.md is missing");
    }
    for (const workflow of ["main.yml", "release.yml", "snapshot-stage.yml"]) {
      const filePath = path.join(repoRoot, ".github", "workflows", workflow);
      if (!existsSync(filePath) || !readText(filePath).includes(PINNED_REF)) {
        issues.push(`${workflow} is not using pinned reusable workflows`);
      }
    }
  } else {
    const appManifestPath = path.join(repoRoot, "app.manifest.ts");
    if (!existsSync(appManifestPath)) {
      issues.push("root app.manifest.ts is missing");
    } else {
      const source = readText(appManifestPath);
      if (!source.includes("entryWorkspace: '.'")) {
        issues.push("app.manifest.ts is missing standalone entryWorkspace");
      }
      if (repoName === "expo-template" && !source.includes("sharedPackages: []")) {
        issues.push("expo-template app.manifest.ts is missing sharedPackages: []");
      }
    }
  }

  if (repoName === "next-template") {
    if (existsSync(path.join(repoRoot, ".github", "workflows", "notify-monorepo-subtree-sync.yml"))) {
      issues.push("next-template still exposes subtree sync workflow");
    }
    const updateGuidePath = path.join(repoRoot, "docs", "updating-from-upstream.md");
    if (!readText(updateGuidePath).includes("@moritzbrantner/platform-upgrader")) {
      issues.push("next-template update guide is not upgrader-based");
    }
    for (const workflow of ["beta-tier.yml", "main-tier.yml", "nightly-tier.yml"]) {
      const filePath = path.join(repoRoot, ".github", "workflows", workflow);
      if (!existsSync(filePath) || !readText(filePath).includes(PINNED_REF)) {
        issues.push(`${workflow} is not using pinned reusable workflows`);
      }
    }
  }

  if (repoName === "expo-template") {
    if (!existsSync(path.join(repoRoot, "e2e", "smoke-auth-contract.spec.ts"))) {
      issues.push("expo-template smoke/auth e2e suite is missing");
    }
    if (existsSync(path.join(repoRoot, "e2e", "example.spec.ts"))) {
      issues.push("expo-template still has example.spec.ts");
    }
    const validateWorkflow = path.join(repoRoot, ".github", "workflows", "validate.yml");
    if (!existsSync(validateWorkflow) || !readText(validateWorkflow).includes(PINNED_REF)) {
      issues.push("expo-template validate workflow is not using pinned reusable workflows");
    }
  }

  if (repoName === "electron-template") {
    if (existsSync(path.join(repoRoot, "scripts", "dispatch-monorepo-update.mjs"))) {
      issues.push("electron-template dispatch sync script still exists");
    }
    if (readText(path.join(repoRoot, "package.json")).includes("sync:monorepo")) {
      issues.push("electron-template package.json still exposes sync:monorepo");
    }
    if (!existsSync(path.join(repoRoot, "e2e", "desktop-smoke.e2e.ts"))) {
      issues.push("electron-template desktop smoke suite is missing");
    }
    const ciWorkflow = path.join(repoRoot, ".github", "workflows", "ci.yml");
    if (!existsSync(ciWorkflow) || !readText(ciWorkflow).includes(PINNED_REF)) {
      issues.push("electron-template CI workflow is not using pinned reusable workflows");
    }
  }

  return {
    config,
    repoName,
    issues,
    ok: issues.length === 0,
  };
}

export function applyScaffoldV2(repoRoot) {
  ensureConfig(repoRoot);

  const changes = [];
  const repoName = path.basename(repoRoot);

  if (repoName === "monorepo" && ensureMonorepoBaseline(repoRoot)) {
    changes.push("SCAFFOLD_V2.md");
  }

  if (upsertAppManifest(path.join(repoRoot, "app.manifest.ts"))) {
    changes.push("app.manifest.ts");
  }

  if (normalizePackageJson(path.join(repoRoot, "package.json"))) {
    changes.push("package.json");
  }

  if (ensureUpdateGuide(repoRoot)) {
    changes.push("docs/updating-from-upstream.md");
  }

  if (renameIfExists(repoRoot, "e2e/example.spec.ts", "e2e/smoke-auth-contract.spec.ts")) {
    changes.push("e2e/smoke-auth-contract.spec.ts");
  }

  if (renameIfExists(repoRoot, "e2e/example.e2e.ts", "e2e/desktop-smoke.e2e.ts")) {
    changes.push("e2e/desktop-smoke.e2e.ts");
  }

  for (const relativePath of [
    "scripts/dispatch-monorepo-update.mjs",
    ".github/workflows/notify-monorepo-subtree-sync.yml",
    ".github/workflows/update-monorepo.yml",
  ]) {
    if (removeIfExists(repoRoot, relativePath)) {
      changes.push(relativePath);
    }
  }

  for (const workflowName of ["validate.yml", "ci.yml", "main.yml", "release.yml", "snapshot-stage.yml"]) {
    if (normalizeWorkflow(repoRoot, workflowName)) {
      changes.push(`.github/workflows/${workflowName}`);
    }
  }

  return {
    repoName,
    changed: changes,
  };
}
