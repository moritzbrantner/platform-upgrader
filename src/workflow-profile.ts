import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";

type ProfileRole = {
  path: string;
  required: boolean;
};

type WorkflowProfile = {
  description?: string;
  maxEnabledRoles: number;
  roles: Record<string, ProfileRole>;
};

type WorkflowProfileCatalog = {
  schemaVersion: 1;
  id: "workflow-profiles-v1";
  profiles: Record<string, WorkflowProfile>;
  legacyWorkflowPaths: string[];
};

type WorkflowException = {
  path: string;
  reason: string;
};

type WorkflowProfileDeclaration = {
  schemaVersion: 1;
  catalog: "workflow-profiles-v1";
  catalogDigest: string;
  profile: string;
  enabledRoles: string[];
  workflows: Record<string, string>;
  exceptions: WorkflowException[];
};

const DECLARATION_PATH = ".github/workflow-profile.json";
const WORKFLOW_PATH = /^\.github\/workflows\/[^/]+\.ya?ml$/;

function readText(filePath: string): string {
  return readFileSync(filePath, "utf8");
}

function writeText(filePath: string, content: string): void {
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, content, "utf8");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function loadCatalog(catalogPath: string): {
  catalog: WorkflowProfileCatalog;
  digest: string;
} {
  const source = readText(catalogPath);
  const digest = `sha256:${createHash("sha256").update(source).digest("hex")}`;
  const value = JSON.parse(source) as unknown;
  if (!isRecord(value) || value.schemaVersion !== 1 || value.id !== "workflow-profiles-v1") {
    throw new Error("Workflow profile catalog must be workflow-profiles-v1 schemaVersion 1");
  }
  if (!isRecord(value.profiles) || !Array.isArray(value.legacyWorkflowPaths)) {
    throw new Error("Workflow profile catalog is missing profiles or legacyWorkflowPaths");
  }

  for (const [profileId, profileValue] of Object.entries(value.profiles)) {
    if (!isRecord(profileValue) || !isRecord(profileValue.roles)) {
      throw new Error(`Workflow profile ${profileId} is invalid`);
    }
    if (
      typeof profileValue.maxEnabledRoles !== "number" ||
      !Number.isInteger(profileValue.maxEnabledRoles) ||
      profileValue.maxEnabledRoles < 1
    ) {
      throw new Error(`Workflow profile ${profileId} has invalid maxEnabledRoles`);
    }
    for (const [role, roleValue] of Object.entries(profileValue.roles)) {
      if (
        !isRecord(roleValue) ||
        typeof roleValue.path !== "string" ||
        !WORKFLOW_PATH.test(roleValue.path) ||
        typeof roleValue.required !== "boolean"
      ) {
        throw new Error(`Workflow profile ${profileId} role ${role} is invalid`);
      }
    }
  }

  for (const legacyPath of value.legacyWorkflowPaths) {
    if (typeof legacyPath !== "string" || !WORKFLOW_PATH.test(legacyPath)) {
      throw new Error(`Invalid legacy workflow path ${String(legacyPath)}`);
    }
  }

  return {
    catalog: value as unknown as WorkflowProfileCatalog,
    digest,
  };
}

function actualWorkflowPaths(repoRoot: string): string[] {
  const directory = path.join(repoRoot, ".github", "workflows");
  if (!existsSync(directory)) {
    return [];
  }
  return readdirSync(directory, { withFileTypes: true })
    .filter((entry) => entry.isFile() && /\.ya?ml$/.test(entry.name))
    .map((entry) => `.github/workflows/${entry.name}`)
    .sort();
}

function parseExceptions(value: unknown): WorkflowException[] {
  if (!Array.isArray(value)) {
    throw new Error("exceptions must be an array");
  }

  const exceptions: WorkflowException[] = [];
  const seen = new Set<string>();
  for (const entry of value) {
    if (
      !isRecord(entry) ||
      typeof entry.path !== "string" ||
      !WORKFLOW_PATH.test(entry.path) ||
      typeof entry.reason !== "string" ||
      entry.reason.trim().length < 8
    ) {
      throw new Error("Each workflow exception requires a canonical path and concrete reason");
    }
    if (seen.has(entry.path)) {
      throw new Error(`Duplicate workflow exception: ${entry.path}`);
    }
    seen.add(entry.path);
    exceptions.push({ path: entry.path, reason: entry.reason });
  }
  return exceptions;
}

function readExceptions(repoRoot: string): WorkflowException[] {
  const declarationPath = path.join(repoRoot, DECLARATION_PATH);
  if (!existsSync(declarationPath)) {
    return [];
  }

  const value = JSON.parse(readText(declarationPath)) as unknown;
  if (!isRecord(value)) {
    throw new Error(`${DECLARATION_PATH} must contain a JSON object`);
  }
  return parseExceptions(value.exceptions ?? []);
}

function resolveDeclaration(
  catalog: WorkflowProfileCatalog,
  catalogDigest: string,
  profileId: string,
  enabledRoles: string[],
  exceptions: WorkflowException[],
): WorkflowProfileDeclaration {
  const profile = catalog.profiles[profileId];
  if (!profile) {
    throw new Error(`Unknown workflow profile: ${profileId}`);
  }

  const uniqueRoles = [...new Set(enabledRoles)];
  if (uniqueRoles.length !== enabledRoles.length || uniqueRoles.some((role) => role.trim() === "")) {
    throw new Error("Enabled workflow roles must be unique non-empty values");
  }
  if (uniqueRoles.length > profile.maxEnabledRoles) {
    throw new Error(
      `Profile ${profileId} allows at most ${profile.maxEnabledRoles} enabled roles`,
    );
  }

  const unknownRoles = uniqueRoles.filter((role) => !profile.roles[role]);
  if (unknownRoles.length > 0) {
    throw new Error(`Profile ${profileId} does not define roles: ${unknownRoles.join(", ")}`);
  }

  const missingRequired = Object.entries(profile.roles)
    .filter(([, role]) => role.required)
    .map(([role]) => role)
    .filter((role) => !uniqueRoles.includes(role));
  if (missingRequired.length > 0) {
    throw new Error(
      `Profile ${profileId} requires roles: ${missingRequired.join(", ")}`,
    );
  }

  const workflows = Object.fromEntries(
    uniqueRoles
      .map((role) => [role, profile.roles[role]!.path] as const)
      .sort(([left], [right]) => left.localeCompare(right)),
  );

  return {
    schemaVersion: 1,
    catalog: "workflow-profiles-v1",
    catalogDigest,
    profile: profileId,
    enabledRoles: [...uniqueRoles].sort(),
    workflows,
    exceptions: [...exceptions].sort((left, right) => left.path.localeCompare(right.path)),
  };
}

function declarationIssues(
  repoRoot: string,
  catalog: WorkflowProfileCatalog,
  digest: string,
): {
  declaration: WorkflowProfileDeclaration | null;
  issues: string[];
} {
  const declarationPath = path.join(repoRoot, DECLARATION_PATH);
  if (!existsSync(declarationPath)) {
    return { declaration: null, issues: [`${DECLARATION_PATH} is missing`] };
  }

  let value: unknown;
  try {
    value = JSON.parse(readText(declarationPath)) as unknown;
  } catch (error) {
    return {
      declaration: null,
      issues: [error instanceof Error ? error.message : String(error)],
    };
  }

  if (!isRecord(value)) {
    return { declaration: null, issues: [`${DECLARATION_PATH} must contain a JSON object`] };
  }

  const profileId = typeof value.profile === "string" ? value.profile : "";
  const enabledRoles = Array.isArray(value.enabledRoles)
    ? value.enabledRoles.filter((entry): entry is string => typeof entry === "string")
    : [];
  let exceptions: WorkflowException[];
  try {
    exceptions = parseExceptions(value.exceptions ?? []);
  } catch (error) {
    return {
      declaration: null,
      issues: [error instanceof Error ? error.message : String(error)],
    };
  }

  let expected: WorkflowProfileDeclaration;
  try {
    expected = resolveDeclaration(catalog, digest, profileId, enabledRoles, exceptions);
  } catch (error) {
    return {
      declaration: null,
      issues: [error instanceof Error ? error.message : String(error)],
    };
  }

  const issues: string[] = [];
  if (value.schemaVersion !== 1) {
    issues.push("schemaVersion must be 1");
  }
  if (value.catalog !== "workflow-profiles-v1") {
    issues.push("catalog must be workflow-profiles-v1");
  }
  if (value.catalogDigest !== digest) {
    issues.push("catalogDigest does not match the supplied catalog");
  }
  if (!isRecord(value.workflows)) {
    issues.push("workflows must be an object");
  } else if (JSON.stringify(value.workflows) !== JSON.stringify(expected.workflows)) {
    issues.push("workflows do not match the selected profile roles");
  }

  return { declaration: expected, issues };
}

export function auditWorkflowProfileV1(repoRoot: string, catalogPath: string) {
  const { catalog, digest } = loadCatalog(catalogPath);
  const { declaration, issues } = declarationIssues(repoRoot, catalog, digest);
  const actual = actualWorkflowPaths(repoRoot);
  const expected = declaration ? Object.values(declaration.workflows).sort() : [];
  const exceptions = declaration?.exceptions.map((entry) => entry.path).sort() ?? [];
  const allowed = new Set([...expected, ...exceptions]);
  const missingWorkflows = expected.filter((workflow) => !actual.includes(workflow));
  const unexpectedWorkflows = actual.filter((workflow) => !allowed.has(workflow));
  const legacySet = new Set(catalog.legacyWorkflowPaths);
  const prunableLegacyWorkflows = unexpectedWorkflows.filter((workflow) =>
    legacySet.has(workflow),
  );

  return {
    schemaVersion: 1,
    migration: "workflow-profile-v1",
    repoName: path.basename(repoRoot),
    catalog: catalog.id,
    catalogDigest: digest,
    declarationPath: DECLARATION_PATH,
    declaration,
    actualWorkflows: actual,
    missingWorkflows,
    unexpectedWorkflows,
    prunableLegacyWorkflows,
    issues: [
      ...issues,
      ...missingWorkflows.map((workflow) => `Missing canonical workflow: ${workflow}`),
      ...unexpectedWorkflows.map((workflow) => `Unexpected workflow: ${workflow}`),
    ],
    ok: issues.length === 0 && missingWorkflows.length === 0 && unexpectedWorkflows.length === 0,
  };
}

export function applyWorkflowProfileV1(
  repoRoot: string,
  catalogPath: string,
  profileId: string,
  enabledRoles: string[],
) {
  const { catalog, digest } = loadCatalog(catalogPath);
  const exceptions = readExceptions(repoRoot);
  const declaration = resolveDeclaration(catalog, digest, profileId, enabledRoles, exceptions);
  const declarationPath = path.join(repoRoot, DECLARATION_PATH);
  const desired = `${JSON.stringify(declaration, null, 2)}\n`;
  const changed: string[] = [];

  if (!existsSync(declarationPath) || readText(declarationPath) !== desired) {
    writeText(declarationPath, desired);
    changed.push(DECLARATION_PATH);
  }

  const expected = new Set(Object.values(declaration.workflows));
  const excepted = new Set(declaration.exceptions.map((entry) => entry.path));
  for (const legacyPath of catalog.legacyWorkflowPaths) {
    if (expected.has(legacyPath) || excepted.has(legacyPath)) {
      continue;
    }
    const absolute = path.join(repoRoot, legacyPath);
    if (!existsSync(absolute)) {
      continue;
    }
    rmSync(absolute, { force: true });
    changed.push(legacyPath);
  }

  return {
    schemaVersion: 1,
    migration: "workflow-profile-v1",
    repoName: path.basename(repoRoot),
    profile: profileId,
    enabledRoles: [...declaration.enabledRoles],
    changed,
    audit: auditWorkflowProfileV1(repoRoot, catalogPath),
  };
}
