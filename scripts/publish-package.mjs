import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");
const registry = "https://npm.pkg.github.com";
const packageJson = JSON.parse(readFileSync(path.join(repoRoot, "package.json"), "utf8"));

function getPublishedVersion(name) {
  try {
    return execFileSync("npm", ["view", name, "version", "--registry", registry], {
      cwd: repoRoot,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  } catch {
    return null;
  }
}

const publishedVersion = getPublishedVersion(packageJson.name);

if (publishedVersion === packageJson.version) {
  console.log(`Skipping ${packageJson.name}@${packageJson.version}; already published.`);
  process.exit(0);
}

execFileSync("npm", ["publish", "--registry", registry], {
  cwd: repoRoot,
  stdio: "inherit",
  env: process.env,
});
