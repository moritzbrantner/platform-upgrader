# platform-upgrader

Private CLI package for deterministic repository audits/migrations plus explicit reviewable toolchain refreshes.

## Commands

Audit a repo without mutating it:

```bash
bunx @moritzbrantner/platform-upgrader audit .
```

Apply a deterministic structural migration:

```bash
bunx @moritzbrantner/platform-upgrader apply scaffold-v2 .
bunx @moritzbrantner/platform-upgrader apply environment-v1 .
```

Discover current stable toolchains and propose exact native pin updates:

```bash
bunx @moritzbrantner/platform-upgrader refresh latest-stable .
```

Persist/clear compatibility state after the caller has evaluated a candidate:

```bash
bunx @moritzbrantner/platform-upgrader hold record bun 1.4.1 <tested-sha> "full gate failed" .
bunx @moritzbrantner/platform-upgrader hold clear bun .
```

## Package contract

- package name: `@moritzbrantner/platform-upgrader`
- deterministic commands:
  - `audit [path]`
  - `apply scaffold-v2 [path]`
  - `apply environment-v1 [path]`
  - `hold record ...`
  - `hold clear ...`
- explicit networked mutation:
  - `refresh latest-stable [path]`
- `audit` remains non-mutating
- every `apply` migration remains deterministic and idempotent
- environment-v1 reads exact toolchain pins from ecosystem-native repository files rather than duplicating versions
- latest-stable refresh resolves every declared supported toolchain before writing, emits a machine-readable proposal report, and never writes floating versions
- refresh proposes candidate pins; the caller's full gate decides acceptance
- `boring-foundation-v1` can opt into authoritative `coding-tooling foundation audit` evidence through `--coding-tooling-root <path>`; authoritative invalid/unsupported state blocks broad mutation and the audit is repeated after apply

## Latest-stable sources

The first supported resolvers are Bun and Rust:

- Bun uses the latest stable `oven-sh/bun` GitHub release and requires an exact `bun-vX.Y.Z` tag.
- Rust uses the official stable channel distribution manifest and reads the exact `pkg.rust.version`.

A compatibility hold suppresses the same failed candidate only against the repository revision that was tested. New repository code or a newer stable candidate may be evaluated again.

## Repository contents

- `src/cli.js`: CLI entrypoint
- `src/index.js`: scaffold-v2 audit/apply implementation
- `src/environment.js`: environment-v1 audit/apply and generated Codex setup/maintenance entrypoint
- `src/foundation.js`: standalone boring-foundation-v1 structural audit/mutation
- `src/foundation-authority.js`: optional coding-tooling foundation authority adapter
- `src/refresh.js`: latest-stable discovery, exact-pin proposal, and compatibility-hold helpers
- `migrations/scaffold-v2.md`: scaffold migration contract notes
- `migrations/environment-v1.md`: environment migration contract notes
- `migrations/foundation-authority.md`: authoritative foundation-audit integration contract
- `migrations/latest-stable.md`: freshness/hold contract notes
- `.platform-upgrader.json.example`: scaffold-family downstream config example
- `tests/platform-upgrader.test.js`: scaffold-v2 coverage
- `tests/environment.test.js`: environment-v1 coverage
- `tests/refresh.test.js`: latest-stable and compatibility-hold coverage

## Release model

- publish to GitHub Packages
- consume from maintained repos with `bunx @moritzbrantner/platform-upgrader ...`
- keep downstream adoption and upgrades reviewable through explicit PRs rather than hidden sync/runtime mutation

See [SCAFFOLD_ALIGNMENT.md](./SCAFFOLD_ALIGNMENT.md) for the scaffold-family alignment contract. The repository-environment contract is owned by `moritzbrantner/monorepo` in `REPOSITORY_ENVIRONMENTS.md`.
