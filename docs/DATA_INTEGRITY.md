# Execution integrity and verification

Intraday mode supports futures journals whose accounts must close positions within each trading session. A futures session starts at 17:00 America/Chicago, including DST. Positions may cross midnight within that session; this journal does not carry unresolved inventory into the next session.

## One economic projection

Raw fills stay immutable. The application uses `journalExecutionLedger` for contract/session inventory and `reconstructJournal` for completed episodes. Generic continuous-inventory and simulator calculations retain `executionLedger`/`reconstruct` for their separate use. Calendar, journal detail, chart context and daily-loss readers must use the same application policy.

An incomplete old session cannot supply entry lots to a later session. Missing opening inventory remains unknown. After the initial opening basis, real buy/sell quantities always enter the inventory reducer, even when a provider entry/exit label disagrees. Such labels cannot discard a fill or create a phantom remaining position. Entry-label disagreements remain a separate diagnostic and require the same independent position/P&L corroboration as position metadata before establishing a new native basis. Neither balanced source quantities nor an internally consistent order archive proves complete broker history. A missing close at the end of a completed session is coverage evidence effective at that boundary, not a synthetic fill or fee. Known earlier fill results remain available; full-session net and any cash interval crossing the gap remain uncertain. Current open positions remain valid partial realized paths until the session ends. Cache expiry includes that boundary even without another upload.

Native replay is bounded to the same session and requires corroborating opening/ending inventory and fee-inclusive results under the existing verification rules. A preserved capture roster omission interrupts idle-counter fallback even if late uploads did not create a per-account not-seen row. Historical prefixes and financial source observations are not rewritten.

## Identity, partial fills and backfills

Execution identity is account-scoped. Conflicting economic records do not overwrite stored prices, sides, quantities or contract identifiers. Repeated identical fills are idempotent. Timestamp precision compatibility requires the same whole UTC second; it cannot silently cross a second or session boundary.

Recorder daily-file `Sequence` is retained as optional `sourceSequence`. A tied timestamp group uses it only when every member has a distinct positive safe integer. Otherwise the stored ordinal remains the ordering basis. Capture order is not a claim about physical exchange sequencing. Daily-loss paths combine the same timestamp rather than inventing intratimestamp drawdown.

Existing financial fields and ordinals are retained when source ordering is enriched. That enrichment advances history/journal revisions. Existing browser files are reparsed once so old receipts cannot suppress the added provenance. Completed-trade IDs keep the account/contract/first-fill/offset hash. Superseded stored and former continuous-projection references remain compatibility evidence, excluded from current totals.

## What each check establishes

- Comparing an original platform export with stored fills checks source preservation and normalization.
- Balanced signed fill cash flow checks internally calculated gross. It does not prove that the source contains every execution.
- Exact platform results with corroborating account/position/session evidence support independent account-result verification. Platform counters alone do not establish a period or fee basis.
- Historical fee gaps remain unknown; current published fees are not silently applied to earlier years.
- Saved profile stage overrides take precedence; account renaming, upgrade status, disappearance or payouts never reconstruct an earlier stage.
- Payouts and firm adjustments remain separate from trading P&L. An incomplete interval cannot manufacture a payout or a higher trailing risk floor.

## Forward capture limits

NinjaTrader `Account.Executions` supplies its exposed current-session collection, not a historical database API. Restart/reconnect polling can recover that collection only. It cannot recover prior-session fills that never reached the recorder. Resolve such gaps from an authoritative platform execution export; never guess a missing fill's price.

Economic amendments/removals remain an explicit review path: immutable-ID conflicts halt the affected import batch, and recorder removal warnings require source review. This release does not implement automatic financial correction/quarantine. Ambiguous manually supplied same-timestamp sequences also cannot be certified from capture order that was never supplied.

Imports, history-size guards and diagnostics are bounded and fail visibly instead of truncating source records. Retained observation scans still require capacity profiling as history grows; current validation is not a guarantee of unlimited retention or of undocumented provider behavior. Windows compilation/provider performance require native verification when recorder code changes.

## Backup transport

The portable backup retains format `tradebook-backup-v1` and the same source fields. The history, profile, note, cash, import, observation, capture, adjustment-label, execution-index and price-bar arrays stream in bounded primary-key pages; history reads at most four accounts per page, and these other arrays at most 500 rows. Current account-state and firm-reference metadata remain separate eager reads. The export does not repeatedly scan already exported rows with OFFSET. Array order is transport order, not trading or posting chronology.

Exports are live reads across multiple queries, not an atomic database snapshot. Concurrent inserts ahead of a cursor can appear once; inserts behind a cursor or edits to already emitted records require a later export. A database failure rejects the download rather than producing a successful truncated backup. Individual record size, invocation limits and concurrent database load still bound a single export; this does not certify unlimited retention.
