# Architecture and data boundaries

`app/` contains the dashboard, dialogs, recorder-folder synchronization and authenticated APIs. `lib/` contains parsing, reconstruction, FIFO realized events, account-state validation, Lucid progress and payout inference. `db/schema.ts` and appended `drizzle/` migrations define D1 storage.

## Persistence

- `account_history`: raw fills, reconstructed completed trades, compact summaries and source revisions.
- `cash_records`, `firm_references`, `account_profiles`, `trade_notes`: owner-maintained records, separate from fills.
- `account_status` and `recorder_status`: latest reported platform values with source timestamps.
- `recorder_captures` and `account_observations`: immutable capture headers and account observations.
- `execution_times`: a canonical timestamp index used to find intervals with offsetting trading activity even when cash is unchanged.
- `balance_adjustment_labels`: owner classifications separate from original source observations.

Repeated imports use stable identity and conflict checks. A replay cannot silently change an existing fill or immutable observation. Late fills and observations cause derived adjustments to be recomputed; obsolete interval labels do not transfer to a different interval.

## Calculations

`execution-ledger.ts` performs one inventory/allocation pass over immutable fills per account/contract. Its FIFO exits and flat-to-flat episodes feed realized reporting and completed trades; there are no independent inventory reducers. `realized.ts` applies the existing dated per-side fees and calendar/session aggregation. `reconstruct.ts` assigns the existing deterministic first-fill/offset IDs.

Execution Position metadata can identify an unknown opening basis, but later contradictions cannot change economic inventory or prices. Explicit exit-only gaps and unsupported opening prices remain unknown. Diagnostic position conflicts remain available to native-report corroboration without blanking otherwise calculable execution profit. Calendar has one daily gross result and completed-trade detail.

The journal and trade/context readers derive current trades from source fills, including legacy histories. Reads do not rewrite stored financial evidence. `supersededTrades`, an optional array in existing history JSON, retains legacy IDs removed by a corrected grouping when a later import rebuilds a history. Those records and their notes remain addressable, while current trading totals contain only the canonical projection. A cached ledger is reusable only when its revision and execution cutoff cover the request without incorporating later fills.

Platform-reported values are not overwritten by these calculations. Firm checkpoints can anchor progress; incomplete inventory, costs or approval ordering keep progress unknown rather than producing a confident number.

A balance adjustment is `cash after - cash before - captured trading net`. Automatic payout estimates require supported, fresh, flat and continuous observations with known coverage. Possible recorded-payout overlaps are excluded from additional inferred income. Hedging profit removals are a distinct category.

## Private release overlays

The live Site owns its original initial-history seed, owner-specific firm notices and hosting identity. GitHub owns source code and synthetic tests. The release adapter preserves those private files in the owner-controlled Sites checkout while importing reviewed public code. Never mirror the private Site's Git history to GitHub.
