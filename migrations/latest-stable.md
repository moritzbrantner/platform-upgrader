# latest-stable toolchain refresh

`refresh latest-stable` is the explicit networked mutation paired with the deterministic `environment-v1` scaffold.

Initial authoritative resolvers:

- Bun: latest non-prerelease GitHub release for `oven-sh/bun`, requiring an exact `bun-vX.Y.Z` tag;
- Rust: the official `channel-rust-stable.toml` distribution manifest, reading `pkg.rust.version`.

The refresh reads exact native pins from `package.json#packageManager` and `rust-toolchain.toml`. It resolves every declared supported toolchain before writing any file, so resolver/network failure leaves the repository unchanged.

The result is a machine-readable report with repository revision, tool, old/new exact versions, resolver source, proposal status, and changed files. A current or ahead-of-resolver pin is not rewritten.

A durable `.repository-environment.toml` compatibility hold suppresses only the same candidate against the same tested repository revision. A newer candidate or changed repository revision may be evaluated again.

The refresh command proposes exact candidate pins; it does not declare them accepted. The caller/reusable workflow must run the repository full gate. On failure it restores candidate pin changes and records a hold. On success it clears any superseded hold and publishes the exact upgrade change.

Hold mutations are exposed as deterministic `hold record` / `hold clear` commands so workflow YAML does not need to implement TOML editing.
