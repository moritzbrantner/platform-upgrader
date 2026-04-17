# Platform Upgrader Reference

This folder is a documentation-only reference pack for a dedicated repository that publishes `@moritzbrantner/platform-upgrader`. It is not a live package inside this monorepo.

## What this reference pack includes

- `.platform-upgrader.json` example
- scaffold-v2 migration contract notes

## How to use it

1. Create a new private repository for the upgrader package.
2. Copy the example config and migration notes from this folder.
3. Build the real CLI package in that repository.
4. Keep `audit` non-mutating and `apply` deterministic.
5. Ship scaffold migrations as explicit reviewable PRs into downstream repos.
