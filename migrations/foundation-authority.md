# Foundation audit authority

`boring-foundation-v1` remains a deterministic mutation owned by `platform-upgrader`, while `coding-tooling foundation audit` is the authoritative read-only foundation classification when a coding-tooling source checkout is supplied.

Use the authority seam during local landscape rollout:

```bash
platform-upgrader audit boring-foundation-v1 . --coding-tooling-root ../coding-tooling
platform-upgrader apply boring-foundation-v1 . --coding-tooling-root ../coding-tooling
platform-upgrader rollout plan boring-foundation-v1 .. --report rollout.json --coding-tooling-root ../coding-tooling
```

The upgrader executes the coding-tooling audit before deciding whether broad mutation is safe. `invalid` and `unsupported` authoritative components block mutation; `missing` components remain pending work and may be repaired by the migration. After an apply, the authoritative audit is run again and recorded beside the local migration audit.

This seam is deliberately explicit. Distribution consumers that do not have a coding-tooling source checkout retain the existing standalone structural audit instead of acquiring a hidden cross-repository runtime dependency.
