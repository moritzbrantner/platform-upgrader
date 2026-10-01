# scaffold-v2 migration contract

This example migration should:

- normalize root workspace scripts
- require `.platform-upgrader.json`
- remove folder-sync baggage
- adopt reusable workflow refs
- normalize `app.manifest.ts` usage

The real upgrader implementation should make deterministic, reviewable edits and remain idempotent across repeated runs.

Generated release callers follow the current shared `release-template.yml@main` interface, including its `contents`, `packages`, and `id-token` write permissions. Those grants are required for GitHub to accept the reusable call even when the scaffold has not configured a publishing command. Publishing remains an explicit caller-owned release command; migration does not run it. The upgrader's own release workflow uses the same interface and frozen dependency installation.
