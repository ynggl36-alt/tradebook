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

Completed trades group flat-to-flat episodes per account/contract. Realized events maintain FIFO inventory and charge each fill's commission at its own time. They are projected into calendar days and 17:00 Central futures sessions.

Platform-reported values are not overwritten by these calculations. Firm checkpoints can anchor progress; incomplete inventory, costs or approval ordering keep progress unknown rather than producing a confident number.

A balance adjustment is `cash after - cash before - captured trading net`. Automatic payout estimates require supported, fresh, flat and continuous observations with known coverage. Possible recorded-payout overlaps are excluded from additional inferred income. Hedging profit removals are a distinct category.

## Private release overlays

The live Site owns its original initial-history seed, owner-specific firm notices and hosting identity. GitHub owns source code and synthetic tests. The release adapter preserves those private files in the owner-controlled Sites checkout while importing reviewed public code. Never mirror the private Site's Git history to GitHub.
