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
  RENOVATE_PRESET,
  applyBoringFoundationV1,
  auditBoringFoundationV1,
} from "../src/foundation.js";

const roots = [];

function fixture() {
  const root = mkdtempSync(path.join(os.tmpdir(), "platform-upgrader-foundation-"));
  roots.push(root);
  return root;
}

function write(root, relativePath, contents) {
  const target = path.join(root, relativePath);
  mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(target, contents, "utf8");
}

function read(root, relativePath) {
  return readFileSync(path.join(root, relativePath), "utf8");
}

afterEach(() => {
  while (roots.length > 0) {
    rmSync(roots.pop(), { recursive: true, force: true });
  }
});

describe("boring-foundation-v1", () => {
  test("applies only safe structural pieces and is idempotent", () => {
    const root = fixture();

    const first = applyBoringFoundationV1(root);

    expect(first.changed.sort()).toEqual(
      [
        ".coding-tooling.json",
        ".repository-environment.toml",
        "AGENTS.md",
        "renovate.json",
        "scripts/codex-environment.sh",
      ].sort(),
    );
    expect(first.audit.safeToApply).toBe(true);
    expect(first.audit.complete).toBe(false);
    expect(first.audit.components.conventions.status).toBe("delegated");
    expect(existsSync(path.join(root, "renovate.json"))).toBe(true);

    const second = applyBoringFoundationV1(root);
    expect(second.changed).toEqual([]);
  });

  test("preserves custom Renovate rules while adding the shared preset", () => {
    const root = fixture();
    write(
      root,
      "renovate.json",
      `${JSON.stringify(
        {
          $schema: "https://docs.renovatebot.com/renovate-schema.json",
          extends: ["config:recommended"],
          packageRules: [{ groupName: "testing", matchDepTypes: ["devDependencies"] }],
        },
        null,
        2,
      )}\n`,
    );

    const result = applyBoringFoundationV1(root);
    const renovate = JSON.parse(read(root, "renovate.json"));

    expect(result.audit.safeToApply).toBe(true);
    expect(renovate.extends).toEqual([RENOVATE_PRESET, "config:recommended"]);
    expect(renovate.packageRules).toEqual([
      { groupName: "testing", matchDepTypes: ["devDependencies"] },
    ]);
  });

  test("preserves a structurally valid existing environment-v1 composition across scaffold evolution", () => {
    const root = fixture();
    const config = `schema_version = 1

[policy]
track = "latest-stable"

[system]
apt = []

[setup]
commands = []

[maintenance]
commands = []

[cache]
paths = []

[compatibility_holds]
`;
    const existingScript = `#!/usr/bin/env bash
set -euo pipefail
mode="\${1:-setup}"
if [[ "$mode" != "setup" && "$mode" != "maintenance" ]]; then exit 2; fi
`;
    write(root, ".repository-environment.toml", config);
    write(root, "scripts/codex-environment.sh", existingScript);

    const audit = auditBoringFoundationV1(root);
    const result = applyBoringFoundationV1(root);

    expect(audit.safeToApply).toBe(true);
    expect(audit.components.environment).toEqual({
      status: "valid",
      reason: "environment-v1-existing-composition-preserved",
      scaffoldDrift: true,
    });
    expect(result.changed).not.toContain("scripts/codex-environment.sh");
    expect(read(root, "scripts/codex-environment.sh")).toBe(existingScript);
  });

  test("refuses to overwrite a custom partial environment contract", () => {
    const root = fixture();
    write(root, "scripts/codex-environment.sh", "#!/usr/bin/env bash\necho custom\n");

    const before = read(root, "scripts/codex-environment.sh");
    const audit = auditBoringFoundationV1(root);
    const result = applyBoringFoundationV1(root);

    expect(audit.safeToApply).toBe(false);
    expect(audit.components.environment.status).toBe("conflict");
    expect(result.changed).toEqual([]);
    expect(read(root, "scripts/codex-environment.sh")).toBe(before);
    expect(existsSync(path.join(root, ".repository-environment.toml"))).toBe(false);
  });

  test("rejects a malformed existing environment script even when config is complete", () => {
    const root = fixture();
    write(
      root,
      ".repository-environment.toml",
      `schema_version = 1

[policy]
track = "latest-stable"
`,
    );
    write(root, "scripts/codex-environment.sh", "#!/bin/sh\necho custom\n");

    const audit = auditBoringFoundationV1(root);

    expect(audit.safeToApply).toBe(false);
    expect(audit.components.environment.status).toBe("conflict");
    expect(audit.components.environment.issues).toContain(
      "scripts/codex-environment.sh does not expose the environment-v1 setup/maintenance contract",
    );
  });

  test("preserves richer coding-tooling and repository guidance", () => {
    const root = fixture();
    const tooling = '{\n  "schemaVersion": 1,\n  "tiers": {"fast": ["test"]}\n}\n';
    const agents = "# Project rules\n\nKeep this repository-specific guidance.\n";
    write(root, ".coding-tooling.json", tooling);
    write(root, "AGENTS.md", agents);

    const result = applyBoringFoundationV1(root);

    expect(result.audit.components.codingTooling.status).toBe("valid");
    expect(result.audit.components.codingTooling.localExtensions).toBe(true);
    expect(read(root, ".coding-tooling.json")).toBe(tooling);
    expect(read(root, "AGENTS.md")).toBe(agents);
  });

  test("reports partial convention installation as a conflict", () => {
    const root = fixture();
    write(root, "conventions.json", '{"schemaVersion":1}\n');

    const audit = auditBoringFoundationV1(root);

    expect(audit.safeToApply).toBe(false);
    expect(audit.components.conventions.status).toBe("conflict");
    expect(audit.components.conventions.reason).toBe("conventions-installation-partial");
  });
});
