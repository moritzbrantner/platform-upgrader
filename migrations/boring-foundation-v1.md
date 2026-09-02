# boring-foundation-v1

`boring-foundation-v1` is the conservative baseline migration for maintained repositories. It normalizes only low-risk repository-owned foundation seams and refuses ambiguous rewrites.

## Owned structural pieces

The migration can safely create or compose:

- environment-v1 when no conflicting custom environment state exists;
- `renovate.json`, preserving JSON repository-specific rules while ensuring the shared `coding-agent-conventions` preset is inherited;
- a minimal `.coding-tooling.json` only when none exists;
- a small `AGENTS.md` starter only when repository-local guidance is absent.

Installed convention snapshots are deliberately **delegated to `coding-tooling conventions`**. The migration reports a missing/partial installation but does not copy policy content or invent a second convention installer.

Hosted CI, runtime profiling, Moonlight, agent contracts, and Agent Loop are outside this migration.

## Commands

```bash
platform-upgrader audit boring-foundation-v1 .
platform-upgrader apply boring-foundation-v1 .
```

The audit is non-mutating. `apply` first audits the repository and performs no mutation when any existing foundation state is ambiguous or conflicting.

## Result semantics

Each component reports one of:

- `valid` — the explicit structural contract is already satisfied;
- `missing` — the migration can add a safe baseline;
- `incomplete` — a safe structural addition is possible without replacing repository-owned configuration;
- `delegated` — an owning tool must perform the operation;
- `conflict` — existing state is ambiguous, malformed, unsupported for preservation, or would require a destructive rewrite.

`safeToApply` means the migration found no conflicts. `complete` additionally requires no missing, incomplete, or delegated work.

## Preservation rules

- Existing `AGENTS.md` is never overwritten.
- Existing valid `.coding-tooling.json` is never normalized back to a generic profile.
- Existing Renovate JSON rules are retained; `renovate.json5` is reported as a conflict until comment-preserving editing is supported.
- Existing custom environment scripts are not replaced by the broad foundation migration.
- Application/runtime dependencies, package-manager choices, toolchain versions, source code, release metadata, deployment policy, and branch strategy are not changed.
- A second successful application over unchanged repository state is a true no-op.

Repository-native deterministic validation remains the acceptance gate for a rollout candidate. Heuristic analyzer findings are separate advisory evidence until individually calibrated and promoted by explicit repository policy.
