# SCAFFOLD_ALIGNMENT.md

## Canonical source

The normative scaffold contract lives in `monorepo/SCAFFOLD_V2.md`.

## Repo role

`platform-upgrader` owns the structural audit/apply CLI for maintained scaffold-family repositories.

## What is local vs shared

Local:
- upgrader CLI implementation
- repo audit/apply logic
- migration notes and fixture coverage

Shared:
- the upgrader contract documented in `monorepo/PLATFORM_UPGRADER.md`
- downstream `.platform-upgrader.json` contract used by maintained repos

## Update path

1. Land upgrader contract changes in `monorepo`.
2. Implement them here and release a new package version.
3. Adopt the new CLI version from maintained repos with explicit PRs.

## What must not drift

- CLI surface: `audit [path]` and `apply scaffold-v2 [path]`
- non-mutating audit behavior
- deterministic, idempotent `apply scaffold-v2`
- `.platform-upgrader.json` contract expected from downstream repos

## Config references

- `.platform-upgrader.json.example`
- `migrations/scaffold-v2.md`
- `.platform-upgrader.json`: not applicable yet for this non-app repo

