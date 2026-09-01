# environment-v1 migration

`apply environment-v1` installs the repository-family-independent environment scaffold defined by `moritzbrantner/monorepo#57` / `REPOSITORY_ENVIRONMENTS.md`.

The migration is deterministic and idempotent. It does not query upstream releases or change accepted toolchain versions.

It creates `.repository-environment.toml` when missing, deriving ordinary Bun/Rust setup commands and cache paths from the repository's existing native files. Existing repository-specific environment configuration is preserved.

It creates or repairs `scripts/codex-environment.sh`, which:

- installs declared apt prerequisites during cold setup;
- installs the exact Bun version from `package.json#packageManager`;
- installs the exact Rust toolchain/components from `rust-toolchain.toml`;
- publishes installed Bun/Cargo bin directories through `GITHUB_PATH` when invoked from GitHub Actions so later workflow steps observe the prepared environment;
- runs setup or maintenance commands declared by the repository;
- preflights observed Bun/Rust versions against the exact native pins.

An existing `.coding-tooling.source-deps.json` declaration is not activated automatically. Source mode is an explicit repository/workspace choice because local-only declarations may require sibling checkouts that do not exist in a cold Codex or CI checkout. A repository that intentionally wants source mode in a prepared workspace can put its existing `scripts/source-deps activate` command in the relevant setup/maintenance commands; environment-v1 never invents or broadens that source graph.

`audit` reports missing environment-v1 files, generated script drift, invalid schema/policy markers, and floating Bun/Rust pins without mutating the repository.

Latest-stable discovery and compatibility-hold mutation are separate from this migration.
