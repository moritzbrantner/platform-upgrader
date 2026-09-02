import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
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
      expect(ENVIRONMENT_SCRIPT).not.toContain("https://bun.sh/install");
      expect(ENVIRONMENT_SCRIPT).not.toContain("https://sh.rustup.rs");
      expect(ENVIRONMENT_SCRIPT).not.toContain("| bash");
      expect(ENVIRONMENT_SCRIPT).not.toContain("| sh");
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
