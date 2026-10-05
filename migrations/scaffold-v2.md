# scaffold-v2 migration contract

This example migration should:

- normalize root workspace scripts
- require `.platform-upgrader.json`
- remove folder-sync baggage
- adopt reusable workflow refs
- normalize `app.manifest.ts` usage

The real upgrader implementation should make deterministic, reviewable edits and remain idempotent across repeated runs.

npm publishing is retired. Migration removes a `.github/workflows/release.yml` that calls the shared `release-template.yml` (its only job was publishing packages) and audit reports one that remains; repository-specific release workflows that do not call the shared template are left untouched. The upgrader itself has no release workflow and is consumed as a commit-pinned git dependency.
