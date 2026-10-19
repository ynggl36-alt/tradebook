# Recorder 0.4.1 validation

Validated October 19, 2026.

- Complete C# source parsed without syntax errors using the C# tree-sitter grammar.
- Architectural checks verify the passive API boundary, background execution
  formatting, queued-record processing after stop, connected-account filtering,
  disconnect/stop recovery paths, optional price subscriptions and schema-1 format.
- All 69 website tests passed, covering legacy capture parsing, raw execution identity, partial
  fills, reversals, simulator isolation, safe retries, reported account values,
  bank/payout separation and retained 2026 history.
- New folder-scan tests verify bounded recent-file lookups against a folder with
  300 archive entries, full-discovery fallback, Central-time midnight rollover,
  visible permission failures and the version-specific snapshot freshness window.
- New realized-ledger tests cover partial exits, FIFO scale-ins, reversals, MES,
  date rollover, missing entries, fee coverage and unchanged completed-trade IDs.
- Revision checks cover safe duplicate imports and protected background updates.
- TypeScript checks passed. A production build is required before publication.

The validation environment has no NinjaTrader Windows assemblies or C# compiler.
These checks do not establish native compilation, event timing, provider behavior
or a measured speed improvement. Compile with F5 and compare responsiveness and
captured executions in the user's NinjaTrader installation before relying on it.

Developer commands:

    node tools/test.mjs
    node node_modules/typescript/bin/tsc --noEmit --incremental false --pretty false
    python3 tools/check-recorder.py

The Python check requires tree-sitter and tree-sitter-c-sharp for validation only.
The source ZIP contains readable source and documentation, with no binary installer.
