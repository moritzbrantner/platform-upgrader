# environment-v1 migration

`apply environment-v1` installs the repository-family-independent environment scaffold defined by `moritzbrantner/monorepo#57` / `REPOSITORY_ENVIRONMENTS.md`.

The migration is deterministic and idempotent. It does not query upstream releases or change accepted toolchain versions.

It creates `.repository-environment.toml` when missing, deriving ordinary Bun/Rust setup commands and cache paths from the repository's existing native files. Existing repository-specific environment configuration is preserved. A root `.bun-version` is accepted as an exact Bun toolchain declaration for Rust-root or otherwise non-JavaScript-root repositories; it does not by itself imply that `bun install` should run at the repository root.

It creates or repairs `scripts/codex-environment.sh`, which:

- requires Python 3 with `tomllib` as an explicit bootstrap prerequisite for parsing repository-owned TOML declarations;
- installs only missing declared apt prerequisites during cold setup;
- requires the exact Bun version from `package.json#packageManager` or `.bun-version` to have been provisioned by a trusted pinned environment mechanism, and fails when both declarations exist but disagree;
- verifies an exact Node version from `.node-version` when the repository declares one;
- provisions only missing exact Rust toolchains/components from `rust-toolchain.toml` through an already-provisioned `rustup`, and fails closed when `rustup` is unavailable;
- never pipes a mutable remote installer directly into a shell;
- publishes installed Bun/Cargo bin directories through `GITHUB_PATH` when invoked from GitHub Actions so later workflow steps observe the prepared environment;
- records a repository-local maintenance fingerprint under Git metadata for the generated conservative Bun/Rust reconciliation commands;
- skips those maintenance reconciliation commands when their relevant manifests, lockfiles, config, generated script, and root toolchain version files are unchanged, while still verifying exact toolchain pins;
- keeps custom maintenance commands conservative: unknown commands are never fingerprint-skipped;
- preflights observed Bun/Node/Rust versions against the exact native pins.

CI callers are expected to provision Python 3 with `tomllib`, Bun, Node, and the rustup bootstrap through immutable or otherwise integrity-verified setup mechanisms before invoking the script. The script owns repository-specific exact-version verification and setup; it intentionally does not bootstrap missing toolchain installers from mutable network URLs.

The maintenance receipt is an execution cache, not repository state. It lives under Git metadata, is not committed, and is valid only for the exact fingerprint of environment-v1 inputs. A cold `setup` always reconciles declared setup commands. A changed fingerprint forces maintenance reconciliation. A matching fingerprint permits the generated conservative maintenance commands to be skipped. Custom maintenance commands remain uncacheable unless a future contract explicitly defines their inputs.

An existing `.coding-tooling.source-deps.json` declaration is not activated automatically. Source mode is an explicit repository/workspace choice because local-only declarations may require sibling checkouts that do not exist in a cold Codex or CI checkout. A repository that intentionally wants source mode in a prepared workspace can put its existing `scripts/source-deps activate` command in the relevant setup/maintenance commands; environment-v1 never invents or broadens that source graph. Such custom commands are deliberately not covered by the automatic maintenance fingerprint.

`audit` reports missing environment-v1 files, generated script drift, invalid schema/policy markers, conflicting Bun declarations, and floating Bun/Node/Rust pins without mutating the repository.

Latest-stable discovery and compatibility-hold mutation are separate from this migration.
