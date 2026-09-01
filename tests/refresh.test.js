import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "bun:test";

import { applyEnvironmentV1 } from "../src/environment.js";
import {
  clearCompatibilityHold,
  readCompatibilityHold,
  recordCompatibilityHold,
  refreshLatestStable,
} from "../src/refresh.js";

async function makeRepo(files) {
  const repo = await mkdtemp(path.join(os.tmpdir(), "platform-refresh-"));
  for (const [relative, contents] of Object.entries(files)) {
    const filePath = path.join(repo, relative);
    await mkdir(path.dirname(filePath), { recursive: true });
    await writeFile(filePath, contents, "utf8");
  }
  return repo;
}

const revisionA = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const revisionB = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

const resolvers = {
  bun: async () => ({ version: "1.4.0", source: "https://example.test/bun" }),
  rust: async () => ({ version: "1.98.0", source: "https://example.test/rust" }),
};

describe("latest-stable refresh", () => {
  it("updates exact Bun and Rust native pins and reports the proposal", async () => {
    const repo = await makeRepo({
      "package.json": '{\n  "name": "fixture",\n  "packageManager": "bun@1.3.14"\n}\n',
      "rust-toolchain.toml": '[toolchain]\nchannel = "1.95.0"\ncomponents = ["clippy"]\n',
    });
    try {
      applyEnvironmentV1(repo);
      const result = await refreshLatestStable(repo, { resolvers, repositoryRevision: revisionA });

      expect(result.changedFiles).toEqual(["package.json", "rust-toolchain.toml"]);
      expect(result.proposals.map((proposal) => proposal.status)).toEqual(["updated", "updated"]);
      expect(await readFile(path.join(repo, "package.json"), "utf8")).toContain('"packageManager": "bun@1.4.0"');
      expect(await readFile(path.join(repo, "rust-toolchain.toml"), "utf8")).toContain('channel = "1.98.0"');
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });

  it("does not partially mutate when any resolver fails", async () => {
    const packageSource = '{"packageManager":"bun@1.3.14"}\n';
    const rustSource = '[toolchain]\nchannel = "1.95.0"\n';
    const repo = await makeRepo({
      "package.json": packageSource,
      "rust-toolchain.toml": rustSource,
    });
    try {
      await expect(
        refreshLatestStable(repo, {
          repositoryRevision: revisionA,
          resolvers: {
            bun: resolvers.bun,
            rust: async () => {
              throw new Error("resolver offline");
            },
          },
        }),
      ).rejects.toThrow("resolver offline");

      expect(await readFile(path.join(repo, "package.json"), "utf8")).toBe(packageSource);
      expect(await readFile(path.join(repo, "rust-toolchain.toml"), "utf8")).toBe(rustSource);
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });

  it("suppresses a held candidate until compatibility-relevant repository content changes", async () => {
    const repo = await makeRepo({ "package.json": '{"packageManager":"bun@1.3.14"}\n' });
    try {
      applyEnvironmentV1(repo);
      recordCompatibilityHold(repo, {
        tool: "bun",
        candidate: "1.4.0",
        testedRevision: revisionA,
        reason: "full gate failed",
      });

      const heldAtSameRevision = await refreshLatestStable(repo, {
        resolvers: { bun: resolvers.bun },
        repositoryRevision: revisionA,
      });
      expect(heldAtSameRevision.changedFiles).toEqual([]);
      expect(heldAtSameRevision.proposals[0].status).toBe("held");

      const heldAfterMetadataOnlyChange = await refreshLatestStable(repo, {
        resolvers: { bun: resolvers.bun },
        repositoryRevision: revisionB,
        compatibilityChangedSince: () => false,
      });
      expect(heldAfterMetadataOnlyChange.changedFiles).toEqual([]);
      expect(heldAfterMetadataOnlyChange.proposals[0].status).toBe("held");
      expect(await readFile(path.join(repo, "package.json"), "utf8")).toContain("bun@1.3.14");

      const retriedAfterSourceChange = await refreshLatestStable(repo, {
        resolvers: { bun: resolvers.bun },
        repositoryRevision: revisionB,
        compatibilityChangedSince: () => true,
      });
      expect(retriedAfterSourceChange.changedFiles).toEqual(["package.json"]);
      expect(retriedAfterSourceChange.proposals[0].status).toBe("updated");
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });

  it("records and clears compatibility holds deterministically", async () => {
    const repo = await makeRepo({ "package.json": '{"packageManager":"bun@1.4.0"}\n' });
    try {
      applyEnvironmentV1(repo);
      const first = recordCompatibilityHold(repo, {
        tool: "bun",
        candidate: "1.4.1",
        testedRevision: revisionA,
        reason: "gate failed\nwith details",
      });
      const second = recordCompatibilityHold(repo, {
        tool: "bun",
        candidate: "1.4.1",
        testedRevision: revisionA,
        reason: "gate failed\nwith details",
      });
      expect(first.changed).toBe(true);
      expect(second.changed).toBe(false);
      expect(readCompatibilityHold(repo, "bun")).toEqual({
        candidate: "1.4.1",
        testedRevision: revisionA,
        reason: "gate failed\nwith details",
      });
      expect(clearCompatibilityHold(repo, "bun").changed).toBe(true);
      expect(clearCompatibilityHold(repo, "bun").changed).toBe(false);
      expect(readCompatibilityHold(repo, "bun")).toBeNull();
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });
});
