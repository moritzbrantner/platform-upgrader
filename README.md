# platform-upgrader

Private CLI package for deterministic repository audits and structural migrations.

## Commands

Audit a repo without mutating it:

```bash
bunx @moritzbrantner/platform-upgrader audit .
```

Apply a structural migration:

```bash
bunx @moritzbrantner/platform-upgrader apply scaffold-v2 .
bunx @moritzbrantner/platform-upgrader apply environment-v1 .
```

You can also run the local checkout directly:

```bash
bun run test
node ./src/cli.js audit ../next-template
node ./src/cli.js apply scaffold-v2 ./tests/fixtures/electron-template
node ./src/cli.js apply environment-v1 ../visual-analysis
```

## Package contract

- package name: `@moritzbrantner/platform-upgrader`
- supported deterministic commands:
  - `audit [path]`
  - `apply scaffold-v2 [path]`
  - `apply environment-v1 [path]`
- `audit` remains non-mutating
- every `apply` migration remains deterministic and idempotent
- environment-v1 reads exact toolchain pins from their ecosystem-native repository files rather than duplicating versions
- latest-stable version discovery is a separate networked mutation and is not part of deterministic environment migration

## Repository contents

- `src/cli.js`: CLI entrypoint
- `src/index.js`: scaffold-v2 audit/apply implementation
- `src/environment.js`: environment-v1 audit/apply implementation and generated Codex setup/maintenance entrypoint
- `migrations/scaffold-v2.md`: scaffold migration contract notes
- `migrations/environment-v1.md`: environment migration contract notes
- `.platform-upgrader.json.example`: scaffold-family downstream config example
- `tests/platform-upgrader.test.js`: scaffold-v2 contract/idempotence coverage
- `tests/environment.test.js`: environment-v1 contract/idempotence coverage

## Release model

- publish to GitHub Packages
- consume from maintained repos with `bunx @moritzbrantner/platform-upgrader ...`
- keep downstream adoption reviewable through explicit PRs rather than hidden sync

See [SCAFFOLD_ALIGNMENT.md](./SCAFFOLD_ALIGNMENT.md) for the scaffold-family alignment contract. The repository-environment contract is owned by `moritzbrantner/monorepo` in `REPOSITORY_ENVIRONMENTS.md`.
