# Recorder 0.5.0 validation

Validation scope, October 20, 2026:

- C# tree-sitter syntax parsing and passive API checks.
- Execution callbacks copy primitive values to the bounded writer queue; queued
  fills drain after stop. All four supported contract families remain included.
- Automatic history uses one-shot provider requests, a flat-account and five-minute
  idle guard, bounded one-day reads, background processing and restart progress.
- Legacy schema-1 XML remains supported. New per-bar observation timestamps prevent
  unrelated fill saves from re-uploading all old candles.
- Website regressions cover durable SQL storage, duplicate retries, stale price
  corrections, atomic conflicts, authentication, backup pagination and unchanged
  financial records. Type checking and production build are required before release.

Commands:

    node tools/test.mjs
    node node_modules/typescript/bin/tsc --noEmit --incremental false
    python3 tools/check-recorder.py

The Python check uses tree-sitter and tree-sitter-c-sharp for validation only.
The environment has **no NinjaTrader Windows assemblies or native C# compiler**.
These checks cannot prove native compilation, provider behavior, event timing or
platform performance. Compile with F5 and compare responsiveness on the owner's
installation before relying on automatic history.
