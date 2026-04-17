# platform-upgrader

Private CLI package for deterministic scaffold-family repo audits and structural migrations.

## Commands

Audit a repo without mutating it:

```bash
bunx @moritzbrantner/platform-upgrader audit .
```

Apply the `scaffold-v2` migration to a target repo:

```bash
bunx @moritzbrantner/platform-upgrader apply scaffold-v2 .
```

You can also run the local checkout directly:

```bash
bun run test
node ./src/cli.js audit ../next-template
node ./src/cli.js apply scaffold-v2 ./tests/fixtures/electron-template
```

## Package contract

- package name: `@moritzbrantner/platform-upgrader`
- supported commands:
  - `audit [path]`
  - `apply scaffold-v2 [path]`
- `audit` must remain non-mutating
- `apply scaffold-v2` must remain deterministic and idempotent

## Repository contents

- `src/cli.js`: CLI entrypoint
- `src/index.js`: audit/apply implementation
- `migrations/scaffold-v2.md`: migration contract notes
- `.platform-upgrader.json.example`: example downstream config
- `tests/platform-upgrader.test.js`: contract and idempotence coverage

## Release model

- publish to GitHub Packages
- consume from maintained repos with `bunx @moritzbrantner/platform-upgrader ...`
- keep downstream adoption reviewable through explicit PRs rather than hidden sync
