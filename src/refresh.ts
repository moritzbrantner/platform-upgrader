import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

const BUN_RELEASE_URL = "https://api.github.com/repos/oven-sh/bun/releases/latest";
const RUST_STABLE_URL = "https://static.rust-lang.org/dist/channel-rust-stable.toml";

type Tool = "bun" | "rust";
type NativePin = {
  tool: Tool;
  version: string;
  file: string;
  source: string;
};
type CompatibilityHold = {
  candidate: string;
  testedRevision: string;
  reason: string;
};
type ResolvedVersion = {
  version: string;
  source: string;
};
type Resolver = () => Promise<ResolvedVersion>;
type RefreshOptions = {
  resolvers?: Partial<Record<Tool, Resolver>>;
  repositoryRevision?: string | null;
  compatibilityChangedSince?: (
    repoRoot: string,
    testedRevision: string,
    currentRevision: string,
  ) => boolean;
};
type HoldSection = {
  start: number;
  end: number;
  text: string;
};
type JsonObject = Record<string, unknown>;

function isRecord(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readText(filePath: string): string {
  return readFileSync(filePath, "utf8");
}

function writeText(filePath: string, value: string): void {
  writeFileSync(filePath, value, "utf8");
}

function exactVersion(value: string, owner: string): string {
  if (!/^\d+\.\d+\.\d+$/.test(value)) {
    throw new Error(`${owner} must use an exact x.y.z version, got ${value}`);
  }
  return value;
}

function versionTuple(value: string): [number, number, number] {
  const [major = 0, minor = 0, patch = 0] = exactVersion(value, "version")
    .split(".")
    .map(Number);
  return [major, minor, patch];
}

function compareVersions(left: string, right: string): number {
  const [leftMajor, leftMinor, leftPatch] = versionTuple(left);
  const [rightMajor, rightMinor, rightPatch] = versionTuple(right);
  if (leftMajor !== rightMajor) {
    return leftMajor - rightMajor;
  }
  if (leftMinor !== rightMinor) {
    return leftMinor - rightMinor;
  }
  return leftPatch - rightPatch;
}

function tomlString(value: string): string {
  return `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"').replaceAll("\n", "\\n")}"`;
}

function currentRevision(repoRoot: string): string {
  return execFileSync("git", ["-C", repoRoot, "rev-parse", "HEAD"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  }).trim();
}

export function repositoryCompatibilityChangedSince(
  repoRoot: string,
  testedRevision: string,
  current: string,
): boolean {
  if (testedRevision === current) {
    return false;
  }
  const result = spawnSync(
    "git",
    [
      "-C",
      repoRoot,
      "diff",
      "--quiet",
      `${testedRevision}..${current}`,
      "--",
      ".",
      ":(exclude).repository-environment.toml",
    ],
    { stdio: "ignore" },
  );
  return result.status !== 0;
}

function nativePins(repoRoot: string): NativePin[] {
  const pins: NativePin[] = [];
  const packagePath = path.join(repoRoot, "package.json");
  if (existsSync(packagePath)) {
    const source = readText(packagePath);
    const parsed = JSON.parse(source) as unknown;
    if (isRecord(parsed) && typeof parsed.packageManager === "string" && parsed.packageManager.startsWith("bun@")) {
      const version = exactVersion(parsed.packageManager.slice(4), "package.json packageManager");
      pins.push({ tool: "bun", version, file: "package.json", source });
    }
  }

  const rustPath = path.join(repoRoot, "rust-toolchain.toml");
  if (existsSync(rustPath)) {
    const source = readText(rustPath);
    const match = source.match(/channel\s*=\s*"([^"]+)"/);
    const candidate = match?.[1];
    if (!candidate) {
      throw new Error("rust-toolchain.toml has no toolchain channel");
    }
    const version = exactVersion(candidate, "rust-toolchain.toml channel");
    pins.push({ tool: "rust", version, file: "rust-toolchain.toml", source });
  }

  return pins;
}

function holdSection(source: string, tool: string): HoldSection | null {
  if (!/^[a-z0-9_-]+$/.test(tool)) {
    throw new Error(`invalid compatibility-hold tool: ${tool}`);
  }
  const header = `[compatibility_holds.${tool}]`;
  const start = source.indexOf(header);
  if (start < 0) {
    return null;
  }
  const afterHeader = source.indexOf("\n", start);
  const bodyStart = afterHeader < 0 ? source.length : afterHeader + 1;
  const nextHeaderMatch = source.slice(bodyStart).match(/^\[[^\]]+\]\s*$/m);
  const end = nextHeaderMatch ? bodyStart + (nextHeaderMatch.index ?? 0) : source.length;
  return { start, end, text: source.slice(start, end) };
}

export function readCompatibilityHold(repoRoot: string, tool: string): CompatibilityHold | null {
  const configPath = path.join(repoRoot, ".repository-environment.toml");
  if (!existsSync(configPath)) {
    return null;
  }
  const section = holdSection(readText(configPath), tool);
  if (!section) {
    return null;
  }
  const field = (name: string): string | null => {
    const match = section.text.match(new RegExp(`^${name}\\s*=\\s*"((?:\\\\.|[^"])*)"\\s*$`, "m"));
    const raw = match?.[1];
    if (!raw) {
      return null;
    }
    return raw.replaceAll("\\n", "\n").replaceAll('\\"', '"').replaceAll("\\\\", "\\");
  };
  const candidate = field("candidate");
  const testedRevision = field("tested_revision");
  const reason = field("reason");
  if (!candidate || !testedRevision || !reason) {
    return null;
  }
  return { candidate, testedRevision, reason };
}

function replaceHoldSection(source: string, tool: string, replacement: string | null): string {
  const existing = holdSection(source, tool);
  if (!existing) {
    if (!replacement) {
      return source;
    }
    return `${source.trimEnd()}\n\n${replacement.trimEnd()}\n`;
  }
  const before = source.slice(0, existing.start).trimEnd();
  const after = source.slice(existing.end).trimStart();
  const parts = [before, replacement?.trim() ?? "", after].filter(Boolean);
  return `${parts.join("\n\n")}\n`;
}

export function recordCompatibilityHold(
  repoRoot: string,
  {
    tool,
    candidate,
    testedRevision,
    reason,
  }: { tool: string; candidate: string; testedRevision: string; reason: string },
) {
  exactVersion(candidate, `${tool} compatibility candidate`);
  if (!/^[0-9a-f]{40}$/i.test(testedRevision)) {
    throw new Error(`tested revision must be a 40-character Git SHA, got ${testedRevision}`);
  }
  const configPath = path.join(repoRoot, ".repository-environment.toml");
  if (!existsSync(configPath)) {
    throw new Error("environment-v1 must be adopted before recording a compatibility hold");
  }
  const source = readText(configPath);
  const replacement = [
    `[compatibility_holds.${tool}]`,
    `candidate = ${tomlString(candidate)}`,
    `tested_revision = ${tomlString(testedRevision)}`,
    `reason = ${tomlString(reason)}`,
  ].join("\n");
  const next = replaceHoldSection(source, tool, replacement);
  if (next !== source) {
    writeText(configPath, next);
  }
  return { tool, candidate, testedRevision, reason, changed: next !== source };
}

export function clearCompatibilityHold(repoRoot: string, tool: string) {
  const configPath = path.join(repoRoot, ".repository-environment.toml");
  if (!existsSync(configPath)) {
    return { tool, changed: false };
  }
  const source = readText(configPath);
  const next = replaceHoldSection(source, tool, null);
  if (next !== source) {
    writeText(configPath, next);
  }
  return { tool, changed: next !== source };
}

export async function resolveLatestBun(fetchImpl: typeof fetch = fetch): Promise<ResolvedVersion> {
  const response = await fetchImpl(BUN_RELEASE_URL, {
    headers: { Accept: "application/vnd.github+json", "User-Agent": "platform-upgrader" },
  });
  if (!response.ok) {
    throw new Error(`Bun release lookup failed with HTTP ${response.status}`);
  }
  const payload = (await response.json()) as unknown;
  const tagName = isRecord(payload) ? payload.tag_name : undefined;
  const match = String(tagName ?? "").match(/^bun-v(\d+\.\d+\.\d+)$/);
  const version = match?.[1];
  if (!version) {
    throw new Error(`unexpected Bun release tag: ${String(tagName ?? "<missing>")}`);
  }
  return { version, source: BUN_RELEASE_URL };
}

export async function resolveLatestRust(fetchImpl: typeof fetch = fetch): Promise<ResolvedVersion> {
  const response = await fetchImpl(RUST_STABLE_URL);
  if (!response.ok) {
    throw new Error(`Rust stable lookup failed with HTTP ${response.status}`);
  }
  const manifest = await response.text();
  const section = manifest.match(/\[pkg\.rust\]([\s\S]*?)(?=\n\[|$)/);
  const sectionText = section?.[1];
  const version = sectionText?.match(/^version\s*=\s*"(\d+\.\d+\.\d+)(?:\s|")/m)?.[1];
  if (!version) {
    throw new Error("could not parse Rust stable version from channel manifest");
  }
  return { version, source: RUST_STABLE_URL };
}

function updatedNativeSource(pin: NativePin, nextVersion: string): string {
  if (pin.tool === "bun") {
    const next = pin.source.replace(
      /("packageManager"\s*:\s*")bun@\d+\.\d+\.\d+("\s*)/,
      `$1bun@${nextVersion}$2`,
    );
    if (next === pin.source) {
      throw new Error("could not update Bun packageManager without reformatting package.json");
    }
    return next;
  }

  const next = pin.source.replace(
    /(channel\s*=\s*")\d+\.\d+\.\d+("\s*)/,
    `$1${nextVersion}$2`,
  );
  if (next === pin.source) {
    throw new Error("could not update rust-toolchain.toml channel");
  }
  return next;
}

export async function refreshLatestStable(
  repoRoot: string,
  {
    resolvers = { bun: resolveLatestBun, rust: resolveLatestRust },
    repositoryRevision = null,
    compatibilityChangedSince = repositoryCompatibilityChangedSince,
  }: RefreshOptions = {},
) {
  const pins = nativePins(repoRoot);
  const revision = repositoryRevision ?? currentRevision(repoRoot);

  const resolved = new Map<Tool, ResolvedVersion>();
  await Promise.all(
    pins.map(async (pin) => {
      const resolver = resolvers[pin.tool];
      if (!resolver) {
        throw new Error(`no latest-stable resolver for ${pin.tool}`);
      }
      const result = await resolver();
      resolved.set(pin.tool, {
        version: exactVersion(result.version, `${pin.tool} resolved version`),
        source: result.source,
      });
    }),
  );

  const proposals: Record<string, unknown>[] = [];
  const writes: { file: string; contents: string }[] = [];
  for (const pin of pins) {
    const latest = resolved.get(pin.tool);
    if (!latest) {
      throw new Error(`missing resolved latest-stable value for ${pin.tool}`);
    }
    const comparison = compareVersions(latest.version, pin.version);
    if (comparison <= 0) {
      proposals.push({
        tool: pin.tool,
        oldVersion: pin.version,
        newVersion: latest.version,
        source: latest.source,
        status: comparison === 0 ? "current" : "ahead-of-resolver",
      });
      continue;
    }

    const hold = readCompatibilityHold(repoRoot, pin.tool);
    const heldAgainstEquivalentRevision =
      hold?.candidate === latest.version &&
      (hold.testedRevision === revision ||
        !compatibilityChangedSince(repoRoot, hold.testedRevision, revision));
    if (heldAgainstEquivalentRevision) {
      proposals.push({
        tool: pin.tool,
        oldVersion: pin.version,
        newVersion: latest.version,
        source: latest.source,
        status: "held",
        hold,
      });
      continue;
    }

    writes.push({ file: pin.file, contents: updatedNativeSource(pin, latest.version) });
    proposals.push({
      tool: pin.tool,
      oldVersion: pin.version,
      newVersion: latest.version,
      source: latest.source,
      status: "updated",
    });
  }

  for (const write of writes) {
    writeText(path.join(repoRoot, write.file), write.contents);
  }

  return {
    schemaVersion: 1,
    operation: "refresh-latest-stable",
    repositoryRevision: revision,
    proposals,
    changedFiles: writes.map((write) => write.file),
  };
}
