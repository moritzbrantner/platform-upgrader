# environment-v1 optimization comparison

Environment-v1 optimization is evaluated by deterministic work performed, not wall-clock timing. CI host load and network variance make elapsed time a poor regression signal for this layer.

## Comparable scenarios

| Scenario | Required behavior | Optimization target |
| --- | --- | --- |
| Cold `setup` | Reconcile declared system/toolchain/package state and run setup commands | Correctness baseline; no skipping |
| First `maintenance` after relevant repository input changes | Reconcile the changed declared state and run maintenance commands | Correctness baseline; no skipping |
| Repeated `maintenance` with identical relevant inputs | Verify toolchain pins/preflight but do not rerun dependency reconciliation commands | Zero maintenance commands |
| Rust setup with the exact toolchain/components already installed | Verify availability and continue | Zero redundant `rustup toolchain install` / component additions |

## Invariants

The optimization must preserve:

- exact ecosystem-native toolchain pins;
- deterministic/idempotent scaffold generation;
- setup and maintenance never discovering or accepting newer toolchain versions;
- latest-stable discovery remaining an explicit separate mutation;
- compatibility holds remaining durable repository state;
- source dependencies remaining explicit repository/workspace choices;
- generated script drift remaining auditable.

## Measurement

Tests should compare observable command counts and receipt/fingerprint transitions. Wall-clock measurements may be collected for diagnostics, but they are not pass/fail criteria.
