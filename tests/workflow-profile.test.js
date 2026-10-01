import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, test } from "bun:test";

import {
  applyWorkflowProfileV1,
  auditWorkflowProfileV1,
} from "../src/workflow-profile.js";

const roots = [];

function fixture() {
  const root = mkdtempSync(path.join(os.tmpdir(), "platform-upgrader-workflow-profile-"));
  roots.push(root);
  return root;
}

function write(root, relativePath, contents) {
  const target = path.join(root, relativePath);
  mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(target, contents, "utf8");
}

function catalog(root) {
  const catalogPath = path.join(root, "workflow-profiles.json");
  writeFileSync(
    catalogPath,
    `${JSON.stringify(
      {
        schemaVersion: 1,
        id: "workflow-profiles-v1",
        profiles: {
          application: {
            maxEnabledRoles: 3,
            roles: {
              validate: { path: ".github/workflows/validate.yml", required: true },
              pages: { path: ".github/workflows/pages.yml", required: false },
              release: { path: ".github/workflows/release.yml", required: false },
            },
          },
        },
        legacyWorkflowPaths: [
          ".github/workflows/beta-tier.yml",
          ".github/workflows/snapshot-stage.yml",
        ],
      },
      null,
      2,
    )}\n`,
  );
  return catalogPath;
}

afterEach(() => {
  while (roots.length > 0) rmSync(roots.pop(), { recursive: true, force: true });
});

describe("workflow-profile-v1", () => {
  test("writes a resolved declaration and only prunes catalog-declared legacy workflows", () => {
    const root = fixture();
    const catalogPath = catalog(root);
    write(root, ".github/workflows/validate.yml", "name: Validate\n");
    write(root, ".github/workflows/pages.yml", "name: Pages\n");
    write(root, ".github/workflows/beta-tier.yml", "name: Legacy beta\n");
    write(root, ".github/workflows/security.yml", "name: Security\n");

    const result = applyWorkflowProfileV1(root, catalogPath, "application", [
      "validate",
      "pages",
    ]);

    expect(result.changed).toContain(".github/workflow-profile.json");
    expect(result.changed).toContain(".github/workflows/beta-tier.yml");
    expect(existsSync(path.join(root, ".github/workflows/beta-tier.yml"))).toBe(false);
    expect(existsSync(path.join(root, ".github/workflows/security.yml"))).toBe(true);
    expect(result.audit.unexpectedWorkflows).toEqual([".github/workflows/security.yml"]);

    const declaration = JSON.parse(
      readFileSync(path.join(root, ".github/workflow-profile.json"), "utf8"),
    );
    expect(declaration).toMatchObject({
      schemaVersion: 1,
      catalog: "workflow-profiles-v1",
      profile: "application",
      enabledRoles: ["pages", "validate"],
      workflows: {
        pages: ".github/workflows/pages.yml",
        validate: ".github/workflows/validate.yml",
      },
    });
    expect(declaration.catalogDigest).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  test("preserves explicit workflow exceptions across reconciliation", () => {
    const root = fixture();
    const catalogPath = catalog(root);
    write(root, ".github/workflows/validate.yml", "name: Validate\n");
    write(root, ".github/workflows/security.yml", "name: Security\n");
    write(
      root,
      ".github/workflow-profile.json",
      `${JSON.stringify({
        schemaVersion: 1,
        catalog: "workflow-profiles-v1",
        catalogDigest: `sha256:${"0".repeat(64)}`,
        profile: "application",
        enabledRoles: ["validate"],
        workflows: { validate: ".github/workflows/validate.yml" },
        exceptions: [
          {
            path: ".github/workflows/security.yml",
            reason: "Separate security publication permission boundary",
          },
        ],
      })}\n`,
    );

    const result = applyWorkflowProfileV1(root, catalogPath, "application", ["validate"]);

    expect(result.audit.ok).toBe(true);
    const declaration = JSON.parse(
      readFileSync(path.join(root, ".github/workflow-profile.json"), "utf8"),
    );
    expect(declaration.exceptions).toEqual([
      {
        path: ".github/workflows/security.yml",
        reason: "Separate security publication permission boundary",
      },
    ]);
  });

  test("rejects malformed existing exceptions before destructive reconciliation", () => {
    const root = fixture();
    const catalogPath = catalog(root);
    write(root, ".github/workflows/validate.yml", "name: Validate\n");
    write(root, ".github/workflows/beta-tier.yml", "name: Legacy beta\n");
    write(
      root,
      ".github/workflow-profile.json",
      `${JSON.stringify({
        schemaVersion: 1,
        catalog: "workflow-profiles-v1",
        catalogDigest: `sha256:${"0".repeat(64)}`,
        profile: "application",
        enabledRoles: ["validate"],
        workflows: { validate: ".github/workflows/validate.yml" },
        exceptions: [
          {
            path: ".github/workflows/beta-tier.yml",
            reason: "short",
          },
        ],
      })}\n`,
    );

    const audit = auditWorkflowProfileV1(root, catalogPath);
    expect(audit.ok).toBe(false);
    expect(audit.issues).toContain(
      "Each workflow exception requires a canonical path and concrete reason",
    );

    expect(() =>
      applyWorkflowProfileV1(root, catalogPath, "application", ["validate"]),
    ).toThrow("Each workflow exception requires a canonical path and concrete reason");
    expect(existsSync(path.join(root, ".github/workflows/beta-tier.yml"))).toBe(true);
  });

  test("is idempotent after convergence", () => {
    const root = fixture();
    const catalogPath = catalog(root);
    write(root, ".github/workflows/validate.yml", "name: Validate\n");

    const first = applyWorkflowProfileV1(root, catalogPath, "application", ["validate"]);
    const second = applyWorkflowProfileV1(root, catalogPath, "application", ["validate"]);

    expect(first.changed).toEqual([".github/workflow-profile.json"]);
    expect(second.changed).toEqual([]);
    expect(second.audit.ok).toBe(true);
  });

  test("rejects unknown roles and missing required roles", () => {
    const root = fixture();
    const catalogPath = catalog(root);

    expect(() =>
      applyWorkflowProfileV1(root, catalogPath, "application", ["pages"]),
    ).toThrow("requires roles: validate");
    expect(() =>
      applyWorkflowProfileV1(root, catalogPath, "application", ["validate", "evidence"]),
    ).toThrow("does not define roles: evidence");
  });

  test("audit reports missing, unexpected, and stale catalog declarations", () => {
    const root = fixture();
    const catalogPath = catalog(root);
    write(root, ".github/workflows/validate.yml", "name: Validate\n");
    write(root, ".github/workflows/extra.yml", "name: Extra\n");
    write(
      root,
      ".github/workflow-profile.json",
      `${JSON.stringify({
        schemaVersion: 1,
        catalog: "workflow-profiles-v1",
        catalogDigest: `sha256:${"f".repeat(64)}`,
        profile: "application",
        enabledRoles: ["validate", "pages"],
        workflows: {
          validate: ".github/workflows/validate.yml",
          pages: ".github/workflows/pages.yml",
        },
        exceptions: [],
      })}\n`,
    );

    const result = auditWorkflowProfileV1(root, catalogPath);

    expect(result.ok).toBe(false);
    expect(result.missingWorkflows).toEqual([".github/workflows/pages.yml"]);
    expect(result.unexpectedWorkflows).toEqual([".github/workflows/extra.yml"]);
    expect(result.issues).toContain("catalogDigest does not match the supplied catalog");
  });
});
