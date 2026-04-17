# scaffold-v2 migration contract

This example migration should:

- normalize root workspace scripts
- require `.platform-upgrader.json`
- remove folder-sync baggage
- adopt reusable workflow refs
- normalize `app.manifest.ts` usage

The real upgrader implementation should make deterministic, reviewable edits and remain idempotent across repeated runs.
