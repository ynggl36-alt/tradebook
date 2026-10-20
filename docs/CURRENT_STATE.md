# Current state

## Baseline

- Initial shared source prepared on 2026-10-19 from the owner's working Tradebook Site.
- Five primary sections: Accounts, Calendar, Analysis, Payouts & costs, Settings.
- Native balances and P&L remain prominent. Dated firm figures and execution-derived estimates remain separately labeled.
- Accounts use compact, responsive cards with five per row at desktop widths of 1440px and above. Funded, evaluation and unclassified accounts have separate sections. Funded sorting uses known qualifying days remaining, not a claim of payout eligibility; unknown cycles follow known progress. Evaluations sort by consistency-adjusted profit remaining, with unconfirmed targets last. Archived labels remain excluded by default.
- FIFO realized accounting includes partial exits, per-fill fees, session grouping and checkpoint uncertainty.
- Immutable account observations support conservative balance-adjustment detection, payout overlap checks and owner classification.
- Payout estimates use 90% for recognized Lucid Flex 50K funded accounts. Inference never writes confirmed cash received or fabricates an approval reset.
- Recorder 0.5.0 captures NQ, MNQ, ES and MES fills. Automatic price catch-up is enabled by default and pauses when trading: one provider calendar day per request, one outstanding request, all monitored accounts flat and five minutes without a fill or new account. It discovers exact contracts from available recent fills and retains progress for restart. Continuous price collection remains a separate optional mode.
- One-minute candles are stored independently in D1 by exact contract and UTC minute, uploaded in retryable 240-row batches. Browser cache v4 queues existing candles gradually and prioritizes current dates; fills and account snapshots take priority. Charts merge cloud and local observations, preserving newer corrections and exposing missing data.
- Migration `0006_purple_micromax.sql` creates only `price_bars`; no financial records are rewritten. Portable backups include keyset-paged candles. Owner-private maintenance supports a read-only backup action for authorized journal work.
- The first GitHub snapshot replaces all owner histories/identifiers with synthetic fixtures and empty deployment defaults. Source-data boundaries differ from the private Site and must be preserved by the release adapter.

## Ownership

- Publisher: original owner Tradebook conversation.
- Second session: contributor and reviewer, using its own task branches.
- Neither session has an exclusive GitHub identity when both use the owner's connected account. No automatic deployment or protected-branch enforcement is assumed.

## Work queue

Owner task (2026-10-20), branch `agent/owner/price-archive-20261020`: durable one-minute price history, automatic candle upload through the existing folder connection, cloud chart recovery, and bounded idle-only NinjaTrader historical catch-up. Owns the price schema/migration, recorder, browser price queue and chart. Accounting and strategy classification are outside this task. No competing schema PR was open at task start.

## Limits

- The public repository does not provide production trading data to either session. Analysis of actual records requires separate owner-authorized journal access.
- Balance inference depends on captured observations and execution coverage. Gaps and uncertain deductions remain visible; it cannot reconstruct absent historical cash observations.
- Long-retention performance of the full balance-interval scan has not been validated at year-scale.
- Historical catch-up covers the latest 35 calendar days for recently traded contracts, subject to provider availability. It does not reconstruct full-year prices or TradingView drawings, and cannot run while NinjaTrader is closed. The connected Chrome journal must be open at some point to upload saved files.
- Native NinjaTrader compilation, provider timing and on-platform performance require validation on the owner's installation. Static C# checks cannot establish those results.
- Managed Work browser preview requires the control-browser skill. Do not improvise a browser when the Sites skill says to skip it.
