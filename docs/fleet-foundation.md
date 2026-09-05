# Fleet foundation guide

The fleet foundation is the small, repeatable contract that lets maintained repositories participate in the same upgrade, validation, and unattended-agent model without copying a large infrastructure stack into every repository.

The rule is:

> Prefer universal thin adoption and selective heavy adoption.

A small Rust library, a Rust/Wasm/Next.js lab, an Expo app, and a mixed application repository do not need identical local environments. They should still expose enough repository-owned state for the fleet to answer the same questions: what platform does this repository use, how is it reproduced, which shared policy applies, how is it validated, and is it safe to automate?

## Ownership model

The intended closed loop is:

**`coding-agent-conventions` defines → `coding-tooling` measures → `platform-upgrader` repairs → `repo-dashboard` exposes → `reusable-workflows` enforces.**

Supporting systems have narrower roles:

| Capability | Owner | Repository participation |
| --- | --- | --- |
| Conventions and shared policy | `coding-agent-conventions` | Reference a profile/preset; do not copy policy by hand. |
| Deterministic foundation classification | `coding-tooling` | Provide repository state for a read-only audit. |
| Structural repair and migration | `platform-upgrader` | Apply only deterministic, reviewable, idempotent changes. |
| Fleet visibility | `repo-dashboard` | Show actionable per-repository foundation state and blockers. |
| CI enforcement | `reusable-workflows` | Enforce promoted repository/fleet contracts through thin callers. |
| Dependency updates | Renovate | Keep a small repository config that inherits fleet policy. |
| GitHub protection/rulesets | GitHub repository configuration | Protect the exact validated head and prevent unsafe direct mutation; this is control-plane state, not a filesystem migration. |

This separation matters. The upgrader should not become a second conventions engine, CI service, dashboard, or GitHub administration layer.

## What `boring-foundation-v1` currently owns

`boring-foundation-v1` is the conservative baseline migration for maintained repositories. It can safely create or compose:

- Environment v1 when there is no conflicting custom environment state;
- `renovate.json` while preserving repository-specific JSON rules and ensuring the shared conventions preset is inherited;
- a minimal `.coding-tooling.json` when none exists;
- a small `AGENTS.md` starter when repository-local agent guidance is absent.

Convention snapshots are delegated to `coding-tooling conventions`. Hosted CI, runtime profiling, Moonlight, agent contracts, Agent Loop, deployment policy, and branch strategy are outside this migration.

That boundary is intentional: the baseline should be boring, reviewable, and safe to apply repeatedly.

## Normal repository workflow

### 1. Audit first

Audit one repository without mutation:

```bash
bunx @moritzbrantner/platform-upgrader audit boring-foundation-v1 .
```

When a local `coding-tooling` checkout is available, use it as the authoritative foundation classifier:

```bash
bunx @moritzbrantner/platform-upgrader audit boring-foundation-v1 . \
  --coding-tooling-root ../coding-tooling
```

Treat invalid, unsupported, contradictory, or otherwise untrustworthy authoritative evidence as a stop condition. Do not broaden the mutation to make the audit pass.

### 2. Apply only the deterministic repair

```bash
bunx @moritzbrantner/platform-upgrader apply boring-foundation-v1 .
```

`apply` audits before mutation and refuses ambiguous/conflicting foundation state. A second successful application over unchanged state must be a no-op.

### 3. Run the repository-owned validation gate

The platform upgrader changes structure; it does not decide whether application behavior is correct. Run the repository's own deterministic validation command after the candidate patch.

A candidate is not accepted merely because the migration completed successfully.

### 4. Roll out through explicit evidence

For multiple repositories, create a resumable rollout report:

```bash
bunx @moritzbrantner/platform-upgrader rollout plan boring-foundation-v1 ~/src \
  --report ./boring-foundation-rollout.json \
  --repos rect,ecs-lab,shader-lab
```

After a repository candidate has passed its own validation, record the result explicitly:

```bash
bunx @moritzbrantner/platform-upgrader rollout record ./boring-foundation-rollout.json rect \
  --status accepted \
  --commit <sha> \
  --pr <number> \
  --validation-command "bun run ci" \
  --validation-status green
```

The rollout report is evidence, not hidden orchestration state. It should preserve the audited revision, detected stack, component states, proposed changes, conflicts, validation command, PR/commit identity, and final disposition.

## Reading foundation state

The baseline migration uses these component states:

- `valid`: the explicit structural contract is already satisfied;
- `missing`: the upgrader can add a safe baseline;
- `incomplete`: a safe addition is possible without replacing repository-owned configuration;
- `delegated`: another owning tool must perform the work;
- `conflict`: applying automatically would be ambiguous, destructive, malformed, or unsupported.

`safeToApply` means no conflicts were found. `complete` is stronger: there is no missing, incomplete, or delegated work left.

Do not turn every descriptive state into a blocking CI rule immediately. New fleet checks should begin as evidence, be dogfooded across representative repository shapes, and become enforcement only after the contract is stable enough to fail closed without creating noise.

## What every maintained repository should eventually have

The exact files differ by stack, but a maintained repository should normally participate in the lightweight contract through:

1. an explicit reproducible environment/toolchain declaration appropriate to its stack;
2. shared conventions/profile references rather than copied policy;
3. deterministic coding-tooling configuration;
4. a thin reusable-workflow entrypoint for promoted CI policy;
5. Renovate adoption for dependency maintenance;
6. protected-main / ruleset configuration that only permits trusted validated changes;
7. enough repository-local guidance for agents to discover the repository-owned validation command and important boundaries.

Heavy environment machinery is optional. The contract is universal; the implementation is stack-specific.

## Repository lifecycle

Do not force active-repository machinery into repositories that are intentionally archived, retired, or historical. Fleet rollout supports an explicit lifecycle manifest so those repositories can still be audited while automatic mutation remains disabled.

Lifecycle state must be explicit and reviewable. Do not infer retirement from repository names or apparent inactivity.

## Dashboard shape

Fleet visibility should be operational rather than decorative. Prefer an actionable matrix such as:

| Repository | Environment | Conventions | Tooling | Renovate | CI | Ruleset | Agent-ready |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `example-a` | valid | valid | valid | missing | valid | missing | blocked |
| `example-b` | conflict | delegated | valid | valid | valid | valid | blocked |

Each non-valid state should lead to the exact evidence and owning remediation path. Avoid summary counters that do not help decide what to fix next.

## Promotion path

When extending the fleet foundation, use this sequence:

1. define the contract in the owning policy repository;
2. add deterministic, read-only detection;
3. dogfood it on several different repository shapes;
4. add a minimal idempotent repair only where ownership belongs in `platform-upgrader`;
5. validate repaired repositories with their own gates;
6. expose actionable state in the dashboard;
7. promote mature checks into reusable CI and unattended-merge requirements.

A useful representative dogfood set includes a Rust library, a Rust/Wasm/Next.js lab, a TypeScript project, an Expo repository, and one mixed/complex repository.

## Failure policy

Fleet automation should fail closed when the evidence needed for a safe mutation is missing, contradictory, stale, or unsupported. It should not silently invent policy, normalize ambiguous repository-owned configuration, weaken validation, or merge around a failed exact-head check.

The goal is not to make every repository look identical. The goal is to make every maintained repository understandable, reproducible, measurable, repairable, and safe to automate through one coherent fleet contract.
