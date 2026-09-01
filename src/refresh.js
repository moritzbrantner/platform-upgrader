import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

const BUN_RELEASE_URL = "https://api.github.com/repos/oven-sh/bun/releases/latest";
const RUST_STABLE_URL = "https://static.rust-lang.org/dist/channel-rust-stable.toml";

function readText(filePath) {
  return readFileSync(filePath, "utf8");
}

function writeText(filePath, value) {
  writeFileSync(filePath, value, "utf8");
}

function exactVersion(value, owner) {
  if (!/^\d+\.\d+\.\d+$/.test(value)) {
    throw new Error(`${owner} must use an exact x.y.z version, got ${value}`);
  }
  return value;
}

function versionTuple(value) {
  return exactVersion(value, "version").split(".").map(Number);
}

function compareVersions(left, right) {
  const a = versionTuple(left);
  const b = versionTuple(right);
  for (let index = 0; index < 3; index += 1) {
    if (a[index] !== b[index]) return a[index] - b[index];
  }
  return 0;
}

function tomlString(value) {
  return `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"').replaceAll("\n", "\\n")}"`;
}

function currentRevision(repoRoot) {
  return execFileSync("git", ["-C", repoRoot, "rev-parse", "HEAD"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  }).trim();
}

function nativePins(repoRoot) {
  const pins = [];
  const packagePath = path.join(repoRoot, "package.json");
  if (existsSync(packagePath)) {
    const source = readText(packagePath);
    const pkg = JSON.parse(source);
    if (typeof pkg.packageManager === "string" && pkg.packageManager.startsWith("bun@")) {
      const version = exactVersion(pkg.packageManager.slice(4), "package.json packageManager");
      pins.push({ tool: "bun", version, file: "package.json", source });
    }
  }

  const rustPath = path.join(repoRoot, "rust-toolchain.toml");
  if (existsSync(rustPath)) {
    const source = readText(rustPath);
    const match = source.match(/channel\s*=\s*"([^"]+)"/);
    if (!match) throw new Error("rust-toolchain.toml has no toolchain channel");
    const version = exactVersion(match[1], "rust-toolchain.toml channel");
    pins.push({ tool: "rust", version, file: "rust-toolchain.toml", source });
  }

  return pins;
}

function holdSection(source, tool) {
  if (!/^[a-z0-9_-]+$/.test(tool)) throw new Error(`invalid compatibility-hold tool: ${tool}`);
  const header = `[compatibility_holds.${tool}]`;
  const start = source.indexOf(header);
  if (start < 0) return null;
  const afterHeader = source.indexOf("\n", start);
  const bodyStart = afterHeader < 0 ? source.length : afterHeader + 1;
  const nextHeaderMatch = source.slice(bodyStart).match(/^\[[^\]]+\]\s*$/m);
  const end = nextHeaderMatch ? bodyStart + nextHeaderMatch.index : source.length;
  return { start, end, text: source.slice(start, end) };
}

export function readCompatibilityHold(repoRoot, tool) {
  const configPath = path.join(repoRoot, ".repository-environment.toml");
  if (!existsSync(configPath)) return null;
  const section = holdSection(readText(configPath), tool);
  if (!section) return null;
  const field = (name) => {
    const match = section.text.match(new RegExp(`^${name}\\s*=\\s*"((?:\\\\.|[^"])*)"\\s*$`, "m"));
    if (!match) return null;
    return match[1].replaceAll("\\n", "\n").replaceAll('\\"', '"').replaceAll("\\\\", "\\");
  };
  const candidate = field("candidate");
  const testedRevision = field("tested_revision");
  const reason = field("reason");
  return candidate && testedRevision && reason
    ? { candidate, testedRevision, reason }
    : null;
}

function replaceHoldSection(source, tool, replacement) {
  const existing = holdSection(source, tool);
  if (!existing) {
    if (!replacement) return source;
    return `${source.trimEnd()}\n\n${replacement.trimEnd()}\n`;
  }
  const before = source.slice(0, existing.start).trimEnd();
  const after = source.slice(existing.end).trimStart();
  const parts = [before, replacement?.trim() ?? "", after].filter(Boolean);
  return `${parts.join("\n\n")}\n`;
}

export function recordCompatibilityHold(repoRoot, { tool, candidate, testedRevision, reason }) {
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
  if (next !== source) writeText(configPath, next);
  return { tool, candidate, testedRevision, reason, changed: next !== source };
}

export function clearCompatibilityHold(repoRoot, tool) {
  const configPath = path.join(repoRoot, ".repository-environment.toml");
  if (!existsSync(configPath)) return { tool, changed: false };
  const source = readText(configPath);
  const next = replaceHoldSection(source, tool, null);
  if (next !== source) writeText(configPath, next);
  return { tool, changed: next !== source };
}

export async function resolveLatestBun(fetchImpl = fetch) {
  const response = await fetchImpl(BUN_RELEASE_URL, {
    headers: { Accept: "application/vnd.github+json", "User-Agent": "platform-upgrader" },
  });
  if (!response.ok) throw new Error(`Bun release lookup failed with HTTP ${response.status}`);
  const payload = await response.json();
  const match = String(payload.tag_name ?? "").match(/^bun-v(\d+\.\d+\.\d+)$/);
  if (!match) throw new Error(`unexpected Bun release tag: ${payload.tag_name ?? "<missing>"}`);
  return { version: match[1], source: BUN_RELEASE_URL };
}

export async function resolveLatestRust(fetchImpl = fetch) {
  const response = await fetchImpl(RUST_STABLE_URL);
  if (!response.ok) throw new Error(`Rust stable lookup failed with HTTP ${response.status}`);
  const manifest = await response.text();
  const section = manifest.match(/\[pkg\.rust\]([\s\S]*?)(?=\n\[|$)/);
  const version = section?.[1].match(/^version\s*=\s*"(\d+\.\d+\.\d+)(?:\s|\")/m)?.[1];
  if (!version) throw new Error("could not parse Rust stable version from channel manifest");
  return { version, source: RUST_STABLE_URL };
}

function updatedNativeSource(pin, nextVersion) {
  if (pin.tool === "bun") {
    const next = pin.source.replace(
      /("packageManager"\s*:\s*")bun@\d+\.\d+\.\d+("\s*)/,
      `$1bun@${nextVersion}$2`,
    );
    if (next === pin.source) throw new Error("could not update Bun packageManager without reformatting package.json");
    return next;
  }
  if (pin.tool === "rust") {
    const next = pin.source.replace(
      /(channel\s*=\s*")\d+\.\d+\.\d+("\s*)/,
      `$1${nextVersion}$2`,
    );
    if (next === pin.source) throw new Error("could not update rust-toolchain.toml channel");
    return next;
  }
  throw new Error(`unsupported toolchain: ${pin.tool}`);
}

export async function refreshLatestStable(
  repoRoot,
  {
    resolvers = { bun: resolveLatestBun, rust: resolveLatestRust },
    repositoryRevision = null,
  } = {},
) {
  const pins = nativePins(repoRoot);
  const revision = repositoryRevision ?? currentRevision(repoRoot);

  // Resolve every declared toolchain before writing any file. Resolver/network failure is therefore non-mutating.
  const resolved = new Map();
  await Promise.all(
    pins.map(async (pin) => {
      const resolver = resolvers[pin.tool];
      if (!resolver) throw new Error(`no latest-stable resolver for ${pin.tool}`);
      const result = await resolver();
      resolved.set(pin.tool, {
        version: exactVersion(result.version, `${pin.tool} resolved version`),
        source: result.source,
      });
    }),
  );

  const proposals = [];
  const writes = [];
  for (const pin of pins) {
    const latest = resolved.get(pin.tool);
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
    if (hold?.candidate === latest.version && hold.testedRevision === revision) {
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
