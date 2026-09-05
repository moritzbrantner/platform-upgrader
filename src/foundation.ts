import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import { ENVIRONMENT_SCRIPT, applyEnvironmentV1, auditEnvironmentV1 } from "./environment.js";

export const BORING_FOUNDATION_VERSION = "boring-foundation-v1";
export const RENOVATE_PRESET = "github>moritzbrantner/coding-agent-conventions";

const ENVIRONMENT_SCAFFOLD_DRIFT = "scripts/codex-environment.sh has environment-v1 scaffold drift";

type JsonObject = Record<string, unknown>;
type FoundationStatus = "missing" | "valid" | "incomplete" | "conflict" | "delegated";
type FoundationComponent = {
  status: FoundationStatus;
  reason: string;
  [key: string]: unknown;
};
type FoundationComponents = {
  environment: FoundationComponent;
  renovate: FoundationComponent;
  codingTooling: FoundationComponent;
  agentGuidance: FoundationComponent;
  conventions: FoundationComponent;
};
type FoundationEntry = FoundationComponent & { component: string };
type ParsedJson = {
  value: JsonObject;
  error: string | null;
};

function isRecord(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readText(filePath: string): string {
  return readFileSync(filePath, "utf8");
}

function writeText(filePath: string, contents: string): void {
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, contents, "utf8");
}

function readJson(filePath: string): ParsedJson {
  try {
    const value = JSON.parse(readText(filePath)) as unknown;
    if (!isRecord(value)) {
      return { value: {}, error: "JSON root must be an object" };
    }
    return { value, error: null };
  } catch (error) {
    return { value: {}, error: error instanceof Error ? error.message : String(error) };
  }
}

function result(
  status: FoundationStatus,
  reason: string,
  extra: JsonObject = {},
): FoundationComponent {
  return { status, reason, ...extra };
}

function existingEnvironmentScriptContractIssue(scriptPath: string): string | null {
  const source = readText(scriptPath);
  if (
    source.startsWith("#!/usr/bin/env bash\n") &&
    source.includes('"setup"') &&
    source.includes('"maintenance"')
  ) {
    return null;
  }
  return "scripts/codex-environment.sh does not expose the environment-v1 setup/maintenance contract";
}

function auditEnvironment(repoRoot: string): FoundationComponent {
  const configPath = path.join(repoRoot, ".repository-environment.toml");
  const scriptPath = path.join(repoRoot, "scripts", "codex-environment.sh");
  const hasConfig = existsSync(configPath);
  const hasScript = existsSync(scriptPath);

  if (!hasConfig && !hasScript) {
    return result("missing", "environment-v1-not-installed");
  }

  const audit = auditEnvironmentV1(repoRoot);
  if (audit.ok) {
    return result("valid", "environment-v1-valid");
  }

  if (!hasConfig || !hasScript) {
    const nonMissingIssues = audit.issues.filter(
      (issue) =>
        issue !== ".repository-environment.toml is missing" &&
        issue !== "scripts/codex-environment.sh is missing",
    );
    if (nonMissingIssues.length === 0) {
      return result("incomplete", "environment-v1-partial", { issues: audit.issues });
    }
    return result("conflict", "environment-v1-existing-state-invalid", {
      issues: audit.issues,
    });
  }

  const scriptContractIssue = existingEnvironmentScriptContractIssue(scriptPath);
  const blockingIssues = audit.issues.filter((issue) => issue !== ENVIRONMENT_SCAFFOLD_DRIFT);
  if (scriptContractIssue) {
    blockingIssues.push(scriptContractIssue);
  }

  if (blockingIssues.length === 0) {
    return result("valid", "environment-v1-existing-composition-preserved", {
      scaffoldDrift: true,
    });
  }

  return result("conflict", "environment-v1-existing-state-invalid", {
    issues: [...new Set([...audit.issues, ...blockingIssues])],
  });
}

function auditRenovate(repoRoot: string): FoundationComponent {
  const jsonPath = path.join(repoRoot, "renovate.json");
  const json5Path = path.join(repoRoot, "renovate.json5");
  const hasJson = existsSync(jsonPath);
  const hasJson5 = existsSync(json5Path);

  if (hasJson && hasJson5) {
    return result("conflict", "renovate-multiple-config-files");
  }
  if (hasJson5) {
    return result("conflict", "renovate-json5-preservation-unsupported");
  }
  if (!hasJson) {
    return result("missing", "renovate-config-missing");
  }

  const parsed = readJson(jsonPath);
  if (parsed.error) {
    return result("conflict", "renovate-json-invalid", { detail: parsed.error });
  }

  const currentExtends = parsed.value.extends;
  if (currentExtends === undefined) {
    return result("incomplete", "renovate-shared-preset-missing");
  }
  if (!Array.isArray(currentExtends) || currentExtends.some((entry) => typeof entry !== "string")) {
    return result("conflict", "renovate-extends-shape-unsupported");
  }
  if (!currentExtends.includes(RENOVATE_PRESET)) {
    return result("incomplete", "renovate-shared-preset-missing");
  }

  return result("valid", "renovate-shared-preset-present", {
    localExtensions: currentExtends.length > 1 || Object.keys(parsed.value).length > 2,
  });
}

function auditCodingTooling(repoRoot: string): FoundationComponent {
  const configPath = path.join(repoRoot, ".coding-tooling.json");
  if (!existsSync(configPath)) {
    return result("missing", "coding-tooling-config-missing");
  }

  const parsed = readJson(configPath);
  if (parsed.error) {
    return result("conflict", "coding-tooling-json-invalid", { detail: parsed.error });
  }
  if (parsed.value.schemaVersion !== 1) {
    return result("conflict", "coding-tooling-schema-unsupported");
  }

  return result("valid", "coding-tooling-config-valid", {
    localExtensions: Object.keys(parsed.value).length > 1,
  });
}

function auditAgentGuidance(repoRoot: string): FoundationComponent {
  if (existsSync(path.join(repoRoot, "AGENTS.md"))) {
    return result("valid", "repository-agent-guidance-present");
  }
  return result("missing", "repository-agent-guidance-missing");
}

function auditConventions(repoRoot: string): FoundationComponent {
  const manifest = existsSync(path.join(repoRoot, "conventions.json"));
  const lock = existsSync(path.join(repoRoot, "conventions.lock.json"));
  const snapshots = existsSync(path.join(repoRoot, ".conventions"));

  if (!manifest && !lock && !snapshots) {
    return result("delegated", "conventions-not-installed", {
      command: "coding-tooling conventions init <repository-modules>",
    });
  }
  if (!(manifest && lock && snapshots)) {
    return result("conflict", "conventions-installation-partial", {
      manifest,
      lock,
      snapshots,
    });
  }

  return result("valid", "conventions-installation-present", {
    verificationCommand: "coding-tooling conventions check --json",
  });
}

export function auditBoringFoundationV1(repoRoot: string) {
  const components: FoundationComponents = {
    environment: auditEnvironment(repoRoot),
    renovate: auditRenovate(repoRoot),
    codingTooling: auditCodingTooling(repoRoot),
    agentGuidance: auditAgentGuidance(repoRoot),
    conventions: auditConventions(repoRoot),
  };

  const entries = Object.entries(components) as [keyof FoundationComponents, FoundationComponent][];
  const conflicts: FoundationEntry[] = entries
    .filter(([, value]) => value.status === "conflict")
    .map(([component, value]) => ({ component, ...value }));
  const pending: FoundationEntry[] = entries
    .filter(
      ([, value]) =>
        value.status === "missing" || value.status === "incomplete" || value.status === "delegated",
    )
    .map(([component, value]) => ({ component, ...value }));

  return {
    schemaVersion: 1,
    migration: BORING_FOUNDATION_VERSION,
    repoName: path.basename(repoRoot),
    components,
    conflicts,
    pending,
    safeToApply: conflicts.length === 0,
    complete: conflicts.length === 0 && pending.length === 0,
  };
}

function applyEnvironment(repoRoot: string, state: FoundationComponent, changed: string[]): void {
  if (state.status === "valid" || state.status === "conflict") {
    return;
  }

  const configPath = path.join(repoRoot, ".repository-environment.toml");
  const scriptPath = path.join(repoRoot, "scripts", "codex-environment.sh");
  if (existsSync(scriptPath) && readText(scriptPath) !== ENVIRONMENT_SCRIPT) {
    return;
  }

  const beforeConfig = existsSync(configPath);
  const beforeScript = existsSync(scriptPath);
  const applied = applyEnvironmentV1(repoRoot);
  for (const file of applied.changed) {
    if (file === ".repository-environment.toml" && beforeConfig) {
      continue;
    }
    if (file === "scripts/codex-environment.sh" && beforeScript) {
      continue;
    }
    changed.push(file);
  }
}

function applyRenovate(repoRoot: string, state: FoundationComponent, changed: string[]): void {
  if (state.status === "valid" || state.status === "conflict") {
    return;
  }

  const configPath = path.join(repoRoot, "renovate.json");
  if (!existsSync(configPath)) {
    writeText(
      configPath,
      `${JSON.stringify(
        {
          $schema: "https://docs.renovatebot.com/renovate-schema.json",
          extends: [RENOVATE_PRESET],
        },
        null,
        2,
      )}\n`,
    );
    changed.push("renovate.json");
    return;
  }

  const parsed = readJson(configPath);
  if (parsed.error) {
    return;
  }
  const currentExtends = parsed.value.extends;
  const nextExtends = currentExtends === undefined ? [] : currentExtends;
  if (!Array.isArray(nextExtends) || nextExtends.some((entry) => typeof entry !== "string")) {
    return;
  }
  if (nextExtends.includes(RENOVATE_PRESET)) {
    return;
  }

  parsed.value.extends = [RENOVATE_PRESET, ...nextExtends];
  writeText(configPath, `${JSON.stringify(parsed.value, null, 2)}\n`);
  changed.push("renovate.json");
}

function applyCodingTooling(repoRoot: string, state: FoundationComponent, changed: string[]): void {
  if (state.status !== "missing") {
    return;
  }
  writeText(path.join(repoRoot, ".coding-tooling.json"), '{\n  "schemaVersion": 1\n}\n');
  changed.push(".coding-tooling.json");
}

function applyAgentGuidance(repoRoot: string, state: FoundationComponent, changed: string[]): void {
  if (state.status !== "missing") {
    return;
  }
  writeText(
    path.join(repoRoot, "AGENTS.md"),
    `# Repository agent guidance\n\nKeep repository-specific commands, architecture boundaries, and deliberate exceptions here.\n\n- Prefer repository-owned deterministic validation commands over inferred commands.\n- Read committed installed conventions when present; repository-local guidance has precedence.\n- Treat heuristic analyzer findings as advisory unless this repository explicitly promotes a detector to a blocking gate.\n`,
  );
  changed.push("AGENTS.md");
}

export function applyBoringFoundationV1(repoRoot: string) {
  const before = auditBoringFoundationV1(repoRoot);
  if (!before.safeToApply) {
    return {
      schemaVersion: 1,
      migration: BORING_FOUNDATION_VERSION,
      repoName: path.basename(repoRoot),
      changed: [],
      skipped: before.conflicts,
      audit: before,
    };
  }

  const changed: string[] = [];
  applyEnvironment(repoRoot, before.components.environment, changed);
  applyRenovate(repoRoot, before.components.renovate, changed);
  applyCodingTooling(repoRoot, before.components.codingTooling, changed);
  applyAgentGuidance(repoRoot, before.components.agentGuidance, changed);

  const audit = auditBoringFoundationV1(repoRoot);
  return {
    schemaVersion: 1,
    migration: BORING_FOUNDATION_VERSION,
    repoName: path.basename(repoRoot),
    changed,
    delegated: audit.pending.filter((entry) => entry.status === "delegated"),
    conflicts: audit.conflicts,
    audit,
  };
}
