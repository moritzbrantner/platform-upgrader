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
- Existing complete Environment v1 composition is repository-owned. If its config and setup/maintenance script still satisfy the structural contract, broad foundation adoption preserves it even when its script bytes predate the latest generated scaffold.
- Scaffold-byte migration belongs to an explicit Environment v1 contract migration or maintenance action, not incidental foundation normalization.
- Application/runtime dependencies, package-manager choices, toolchain versions, source code, release metadata, deployment policy, and branch strategy are not changed.
- A second successful application over unchanged repository state is a true no-op.

Repository-native deterministic validation remains the acceptance gate for a rollout candidate. Heuristic analyzer findings are separate advisory evidence until individually calibrated and promoted by explicit repository policy.

## Resumable fleet rollout reports

Broad adoption is coordinated with a versioned local JSON report rather than hidden agent state:

```bash
platform-upgrader rollout plan boring-foundation-v1 ~/src \
  --report ./boring-foundation-rollout.json \
  --repos rect,ecs-lab,shader-lab
```

Each repository record contains the audited default-branch revision (falling back to the checked-out revision when `origin/HEAD` is unavailable), detected stack evidence, current foundation component states, proposed deterministic changes, conflicts, a repository-owned validation command when one can be resolved, application commit/PR identity, and final rollout status.

Re-running the plan with the same report safely resumes records already marked `accepted` only when the audited revision is unchanged. A moved default branch is re-audited and returns to a non-accepted state.

External rollout orchestration records results explicitly:

```bash
platform-upgrader rollout record ./boring-foundation-rollout.json rect \
  --status accepted \
  --commit <sha> \
  --pr <number> \
  --validation-command "bun run ci" \
  --validation-status green
```

The report refuses an `accepted` status unless repository-native validation is recorded as green. The rollout command never auto-merges a repository.
