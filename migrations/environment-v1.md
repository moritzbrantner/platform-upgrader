# environment-v1 migration

`apply environment-v1` installs the repository-family-independent environment scaffold defined by `moritzbrantner/monorepo#57` / `REPOSITORY_ENVIRONMENTS.md`.

The migration is deterministic and idempotent. It does not query upstream releases or change accepted toolchain versions.

It creates `.repository-environment.toml` when missing, deriving ordinary Bun/Rust setup commands and cache paths from the repository's existing native files. Existing repository-specific environment configuration is preserved.

It creates or repairs `scripts/codex-environment.sh`, which:

- installs declared apt prerequisites during cold setup;
- installs the exact Bun version from `package.json#packageManager`;
- installs the exact Rust toolchain/components from `rust-toolchain.toml`;
- activates an existing `.coding-tooling.source-deps.json` declaration through the repository/source-deps tooling;
- runs setup or maintenance commands declared by the repository;
- preflights observed Bun/Rust versions against the exact native pins.

`audit` reports missing environment-v1 files, generated script drift, invalid schema/policy markers, and floating Bun/Rust pins without mutating the repository.

Latest-stable discovery and compatibility-hold mutation are separate from this migration.
