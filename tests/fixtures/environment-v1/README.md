# environment-v1 optimization fixtures

This directory documents deterministic comparison scenarios for environment-v1 optimization. Tests should compare observable reconciliation work rather than elapsed wall-clock time.

- cold setup: reconcile everything declared;
- changed maintenance: reconcile after relevant declared state changes;
- unchanged maintenance: perform preflight but skip dependency commands;
- warm Rust: skip already-satisfied toolchain/components.
