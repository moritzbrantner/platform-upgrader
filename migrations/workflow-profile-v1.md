# workflow-profile-v1

`workflow-profile-v1` reconciles a repository to the canonical workflow topology defined by a supplied `reusable-workflows` profile catalog.

## Inputs

The migration is deliberately explicit:

- `--catalog <path>` points to `profiles/workflow-profiles.json` from `reusable-workflows`;
- `--profile <id>` selects one canonical repository profile;
- `--roles <role,...>` selects the roles the repository actually enables.

The migration never guesses a repository profile from its name or technology stack.

## Apply

```bash
platform-upgrader apply workflow-profile-v1 . \
  --catalog ../reusable-workflows/profiles/workflow-profiles.json \
  --profile engine-lab \
  --roles validate,pages,evidence
```

Apply writes `.github/workflow-profile.json` with the selected profile, enabled roles, canonical workflow paths, and a SHA-256 digest of the supplied catalog. Existing valid reasoned exceptions are preserved.

The migration may remove only workflow paths listed in the catalog's global `legacyWorkflowPaths` set, and only when they are neither canonical enabled paths nor explicit exceptions. Unknown extra workflows are never deleted implicitly.

Apply does not invent repository-specific validation, build, release, or deployment commands. Missing canonical callers remain visible in the post-apply audit and must be created or migrated deliberately.

## Audit

```bash
platform-upgrader audit workflow-profile-v1 . \
  --catalog ../reusable-workflows/profiles/workflow-profiles.json
```

Audit verifies the declaration against the supplied catalog and reports:

- catalog digest drift;
- missing canonical workflows;
- undeclared extra workflows;
- globally known legacy workflows that are safe pruning candidates.

`coding-tooling workflow-profile audit` is the repository-local offline drift gate after the declaration has been resolved.

## Idempotence

Applying the same profile and roles against the same catalog twice is a no-op after convergence.
