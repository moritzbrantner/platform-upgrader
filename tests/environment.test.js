import { spawnSync } from "node:child_process";
import { chmod, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "bun:test";

import {
  ENVIRONMENT_SCRIPT,
  applyEnvironmentV1,
  auditEnvironmentV1,
} from "../src/environment.js";

async function makeRepo(root, name, files) {
  const repo = path.join(root, name);
  await mkdir(repo, { recursive: true });
  for (const [relative, contents] of Object.entries(files)) {
    const filePath = path.join(repo, relative);
    await mkdir(path.dirname(filePath), { recursive: true });
    await writeFile(filePath, contents, "utf8");
  }
  return repo;
}

function run(command, args, cwd, env = process.env) {
  const result = spawnSync(command, args, { cwd, encoding: "utf8", env });
  expect(result.status, `${command} ${args.join(" ")}\n${result.stderr}`).toBe(0);
  return result;
}

describe("environment-v1", () => {
  it("creates deterministic idempotent Bun, Node, Rust, and combined environments", async () => {
    const tempRoot = await mkdtemp(path.join(os.tmpdir(), "platform-env-v1-"));
    try {
      const cases = [
        ["bun-only", { "package.json": '{"packageManager":"bun@1.4.0"}\n' }],
        ["node-only", { ".node-version": "24.20.0\n" }],
        [
          "rust-only",
          { "rust-toolchain.toml": '[toolchain]\nchannel = "1.98.0"\ncomponents = ["clippy", "rustfmt"]\n' },
        ],
        [
          "bun-node-rust",
          {
            "package.json": '{"packageManager":"bun@1.4.0"}\n',
            ".node-version": "24.20.0\n",
            "rust-toolchain.toml": '[toolchain]\nchannel = "1.98.0"\n',
          },
        ],
      ];

      for (const [name, files] of cases) {
        const repo = await makeRepo(tempRoot, name, files);
        const first = applyEnvironmentV1(repo);
        const second = applyEnvironmentV1(repo);
        expect(first.changed).toEqual([
          ".repository-environment.toml",
          "scripts/codex-environment.sh",
        ]);
        expect(second.changed).toEqual([]);
        expect(auditEnvironmentV1(repo)).toEqual({ issues: [], ok: true });
      }

      const combinedConfig = await readFile(
        path.join(tempRoot, "bun-node-rust", ".repository-environment.toml"),
        "utf8",
      );
      expect(combinedConfig).toContain("bun install --frozen-lockfile");
      expect(combinedConfig).toContain("cargo fetch --locked");
      expect(ENVIRONMENT_SCRIPT).toContain("GITHUB_PATH");
      expect(ENVIRONMENT_SCRIPT).toContain(".node-version");
      expect(ENVIRONMENT_SCRIPT).toContain("environment-v1-maintenance.sha256");
      expect(ENVIRONMENT_SCRIPT).toContain("maintenance inputs unchanged");
      expect(ENVIRONMENT_SCRIPT).toContain('bash -c "$command"');
      expect(ENVIRONMENT_SCRIPT).not.toContain('bash -lc "$command"');
      expect(ENVIRONMENT_SCRIPT).not.toContain("https://bun.sh/install");
      expect(ENVIRONMENT_SCRIPT).not.toContain("https://sh.rustup.rs");
      expect(ENVIRONMENT_SCRIPT).not.toContain("| bash");
      expect(ENVIRONMENT_SCRIPT).not.toContain("| sh");
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  it("makes unchanged maintenance a comparable zero-reconciliation path", async () => {
    const tempRoot = await mkdtemp(path.join(os.tmpdir(), "platform-env-compare-"));
    try {
      const repo = await makeRepo(tempRoot, "compare", {
        "package.json": `${JSON.stringify({ packageManager: `bun@${Bun.version}` })}\n`,
        "README.md": "baseline\n",
      });
      applyEnvironmentV1(repo);

      const bin = path.join(tempRoot, "bin");
      const actions = path.join(tempRoot, "actions.log");
      await mkdir(bin, { recursive: true });
      const fakeBun = path.join(bin, "bun");
      await writeFile(
        fakeBun,
        `#!/usr/bin/env bash
set -euo pipefail
if [[ "\${1:-}" == "--version" ]]; then
  printf '%s\\n' "\${BUN_FAKE_VERSION:?}"
  exit 0
fi
printf '%s\\n' "$*" >> "\${ENV_ACTIONS:?}"
`,
        "utf8",
      );
      await chmod(fakeBun, 0o755);
      await chmod(path.join(repo, "scripts", "codex-environment.sh"), 0o755);

      run("git", ["init", "-q"], repo);
      run("git", ["add", "."], repo);
      run(
        "git",
        [
          "-c",
          "user.name=environment-v1-test",
          "-c",
          "user.email=environment-v1@example.invalid",
          "commit",
          "-qm",
          "baseline",
        ],
        repo,
      );

      const env = {
        ...process.env,
        PATH: `${bin}${path.delimiter}${process.env.PATH ?? ""}`,
        BUN_FAKE_VERSION: Bun.version,
        ENV_ACTIONS: actions,
      };
      run("bash", ["scripts/codex-environment.sh", "setup"], repo, env);
      expect((await readFile(actions, "utf8")).trim().split("\n")).toEqual([
        "install --frozen-lockfile",
      ]);

      const unchanged = run("bash", ["scripts/codex-environment.sh", "maintenance"], repo, env);
      expect(unchanged.stdout).toContain("skipping 1 reconciliation command(s)");
      expect((await readFile(actions, "utf8")).trim().split("\n")).toHaveLength(1);

      await writeFile(path.join(repo, "README.md"), "unrelated change\n", "utf8");
      const unrelated = run("bash", ["scripts/codex-environment.sh", "maintenance"], repo, env);
      expect(unrelated.stdout).toContain("skipping 1 reconciliation command(s)");
      expect((await readFile(actions, "utf8")).trim().split("\n")).toHaveLength(1);

      await writeFile(
        path.join(repo, "package.json"),
        `${JSON.stringify({ packageManager: `bun@${Bun.version}`, description: "environment input changed" })}\n`,
        "utf8",
      );
      const changed = run("bash", ["scripts/codex-environment.sh", "maintenance"], repo, env);
      expect(changed.stdout).not.toContain("maintenance inputs unchanged");
      expect((await readFile(actions, "utf8")).trim().split("\n")).toHaveLength(2);
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  it("preserves repository-specific visual prerequisites and exact source declarations", async () => {
    const tempRoot = await mkdtemp(path.join(os.tmpdir(), "platform-env-visual-"));
    try {
      const config = `schema_version = 1

[policy]
track = "latest-stable"

[system]
apt = ["ffmpeg", "poppler-utils", "tesseract-ocr"]

[setup]
commands = ["bun install --frozen-lockfile", "cargo fetch"]

[maintenance]
commands = ["bun install --frozen-lockfile", "cargo fetch"]

[cache]
paths = ["~/.cargo", "~/.bun/install/cache"]

[compatibility_holds]
`;
      const repo = await makeRepo(tempRoot, "visual-analysis", {
        "package.json": '{"packageManager":"bun@1.4.0"}\n',
        "rust-toolchain.toml": '[toolchain]\nchannel = "1.98.0"\n',
        ".repository-environment.toml": config,
        ".coding-tooling.source-deps.json": JSON.stringify({
          schemaVersion: 2,
          cargo: {
            patches: [
              {
                package: "moenarch-runtime-core",
                git: "https://github.com/moritzbrantner/moenarch-foundation",
                rev: "648e3ef18dc5d32d5fcbb211ed7a118b2731a387",
                localPath: "../moenarch-foundation/crates/runtime/runtime-core",
              },
            ],
          },
        }),
      });

      const result = applyEnvironmentV1(repo);
      expect(result.changed).toEqual(["scripts/codex-environment.sh"]);
      expect(await readFile(path.join(repo, ".repository-environment.toml"), "utf8")).toBe(config);
      expect(await readFile(path.join(repo, "scripts", "codex-environment.sh"), "utf8")).toBe(
        ENVIRONMENT_SCRIPT,
      );
      expect(ENVIRONMENT_SCRIPT).not.toContain("source-deps");
      expect(auditEnvironmentV1(repo)).toEqual({ issues: [], ok: true });
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  it("reports floating pins and generated scaffold drift", async () => {
    const tempRoot = await mkdtemp(path.join(os.tmpdir(), "platform-env-drift-"));
    try {
      const repo = await makeRepo(tempRoot, "drift", {
        "package.json": '{"packageManager":"bun@latest"}\n',
        ".node-version": "24\n",
        "rust-toolchain.toml": '[toolchain]\nchannel = "stable"\n',
      });
      applyEnvironmentV1(repo);
      await writeFile(path.join(repo, "scripts", "codex-environment.sh"), "#!/bin/sh\n", "utf8");

      const result = auditEnvironmentV1(repo);
      expect(result.ok).toBe(false);
      expect(result.issues).toContain("scripts/codex-environment.sh has environment-v1 scaffold drift");
      expect(result.issues.some((issue) => issue.includes("packageManager must pin Bun exactly"))).toBe(true);
      expect(result.issues.some((issue) => issue.includes(".node-version must pin Node exactly"))).toBe(true);
      expect(result.issues.some((issue) => issue.includes("must pin Rust exactly"))).toBe(true);
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });
});
