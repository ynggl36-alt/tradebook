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
- Weekly opening gaps use exact-contract one-minute Friday-close/Sunday-open candles, with DST-aware Central-time boundaries and a 35-day lookback before the selected entry. Faint grey zones extend to the final candle in the view, with midpoint guides; later fills/touches do not remove them. Missing regular-session boundaries, including holiday/early-close cases, remain unavailable. This is chart context, not automatic strategy classification.
- Analysis → Entries has a read-only automatic context pilot for the latest 60 supported completed trades under the current filters. It checks the actual first allocated fill, excluding later scale-ins, against recorded gap edges, midpoints and zones. Near-level proximity is provisionally the greater of four ticks and one-quarter of the mean true range of the preceding 14 completed 1m candles, requiring 20 consecutive pre-entry minutes. The entry minute is excluded. Missing first fills, candles and weekly boundaries remain unknown; an absent recorded match is not a strategy classification. Trendlines and gaps older than 35 days are not checked.
- Context refreshes on selection changes and completed device price uploads, with a manual saved-data refresh. Requests use at most 20 canonical trade references and 45 read-only SQL statements; they write no tags, financial records or schema. Matched location subsets overlap, and their results describe full completed trades after modeled commissions. Missing commission coverage leaves aggregate net statistics unavailable. These small recent samples are not full-period strategy performance.
- The first GitHub snapshot replaces all owner histories/identifiers with synthetic fixtures and empty deployment defaults. Source-data boundaries differ from the private Site and must be preserved by the release adapter.

## Ownership

- Publisher: original owner Tradebook conversation.
- Second session: contributor and reviewer, using its own task branches.
- Neither session has an exclusive GitHub identity when both use the owner's connected account. No automatic deployment or protected-branch enforcement is assumed.

## Work queue

Owner task (2026-10-20), branch `agent/owner/gap-context-pilot-20261020`: bounded automatic weekly-gap context pilot. Owns `lib/gap-context.ts`, `lib/server-gap-context.ts`, `app/gap-context-panel.tsx`, the read-only API/Analysis integration, the calendar cache, related regressions and this document. No recorder, schema or financial-accounting changes. No competing PR was open at task start. Before extending this into strategy comparisons, validate positive measured-location examples against charts and improve historical coverage; do not infer intended strategy from proximity.

## Limits

- The public repository does not provide production trading data to either session. Analysis of actual records requires separate owner-authorized journal access.
- Balance inference depends on captured observations and execution coverage. Gaps and uncertain deductions remain visible; it cannot reconstruct absent historical cash observations.
- Long-retention performance of the full balance-interval scan has not been validated at year-scale.
- Historical catch-up covers the latest 35 calendar days for recently traded contracts, subject to provider availability. It does not reconstruct full-year prices or TradingView drawings, and cannot run while NinjaTrader is closed. The connected Chrome journal must be open at some point to upload saved files.
- Native NinjaTrader compilation, provider timing and on-platform performance require validation on the owner's installation. Static C# checks cannot establish those results.
- Managed Work browser preview requires the control-browser skill. Do not improvise a browser when the Sites skill says to skip it.

## Trendline pilot (2026-10-20)

Owner task, branch `agent/owner/trendline-pilot-20261020`: automatic retrospective trendlines for Central entry dates October 7–20, 2026. Owns `lib/trendlines.ts`, `lib/trendline-runner.ts`, the read-only canonical-entry endpoint, worker/client/panel, chart overlays, scoped styles and regressions. No recorder, schema, financial calculation or persisted review changes. No competing pull request was open at task start.

- Analysis → Entries starts with Trendline lab. It measures all supported completed entries in the fixed pilot under the current filters, up to 2,000 newest entries with explicit truncation. Actual first allocated fills are validated on the server in batches of 40 with at most 10 read-only SQL statements; averages and same-clock scale-ins are never fallbacks.
- Complete exact-contract 1m/5m/15m candles supply continuous-session candidates. Any missing minute or session closure splits geometry; daily/cross-session lines are deferred. Swing anchors need two complete candles on each side. Impulse candles (body ≥70% of range, true range ≥1.5× prior-14 ATR) are an additional shared anchor route; ATR excludes the impulse candle. Backfill completion establishes mathematical availability, not evidence of actual live availability.
- Every shared timestamp pair receives WW/BB/WB/BW variants before style selection. Limits are 720 bars in the current session, 28 timestamp anchors per side and 160 shared pairs per side/timeframe; search bounds are exposed. Identical volatility tolerance, close breaches and clustered wick/body edge contacts apply to all variants. A pair supplies zero independent confirmations; contacts only start after both anchors are available. Geometry prefers independently touched candidates, then fit/span, selecting up to two per style without entry price, trade direction or outcomes.
- Charts show candidates only for the pilot dates, colored by anchor style; their pre-confirmation portions are dashed and post-entry projections dotted. Coincident paths are collapsed visually while retaining style measurements. Line slopes and chart axes both use wall-clock time. Missing history is not filled in. The existing PNG export includes overlays.
- Entry comparison uses a quarter of prior-14 1m ATR with a four-tick floor and excludes the entry minute. Mutually exclusive body-only/wick-only/both/neither groups refer to selected intact candidates with an independent touch; mixed matches are separate. Net results describe complete trades after existing modeled commissions, not strategy attribution, payouts or account costs. Missing fee coverage leaves group net results unknown.
- A separate matched WW/BB replay observes 12 candles after a pair’s mathematical availability: both styles must pass formation; a contact must occur in the first nine, no close breach may occur in all 12, and a move away within three candles must reach max(one point, half the contact candle’s prior ATR). Unique pair observations remain overlapping and are sampled from retrospective entry reconstructions, not a prospective strategy test. Replay outcomes cannot change entry labels or ranking.
- Analysis runs in a cancellable browser worker and refreshes after completed price uploads or manual refresh, without additional NinjaTrader work or persistent automatic tags. Real owner data and calibration outputs remain outside the public repository.
