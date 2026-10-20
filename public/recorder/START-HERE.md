# Tradebook recorder 0.5.0 — automatic chart history

Replace the existing source once, after trading. The recorder keeps using your
**accounts-v2** folder and preserves saved executions. No executable installer,
extra broker login, TradingView script or daily upload is required.

## Update once

1. In the old recorder, **Stop and save**, wait for it to stop, then close its window.
2. Open **New → NinjaScript Editor → AddOns → TradebookRecorder**.
3. Open **TradebookRecorder.cs** as text. Copy the whole file; in the existing
   NinjaScript tab, **Ctrl+A**, paste, save and **F5**. Replace the existing AddOn.
4. Open **New → Tradebook recorder**. Confirm the heading says **0.5.0**.
5. Keep **Connected accounts — read-only**, your **LFE; LFF** prefixes, and
   **Catch up chart history automatically while flat and idle** enabled.
   Leave **Also collect one-minute prices** unchecked for normal use.
6. Start recording. Keep the recorder open or minimized. Enable automatic startup
   if desired; the existing setting is preserved.
7. Refresh Tradebook in Chrome. Keep the existing **accounts-v2** folder connection
   and journal sync enabled. Grant folder permission again if Chrome requests it.

The website's **Recorder source** link is a plain text source file. A ZIP is optional.

## Normal daily use

Trade as usual. Fills save about every **10 seconds**; balances and positions about
every **60 seconds**. The website checks recent files about every **30 seconds**
while visible and less often in the background. You do not need to operate
TradingView for journal sync.

After **all monitored accounts are flat** and **five minutes without a fill or
new account**, automatic history starts. It requests **one calendar day for one
contract at a time**, starting with today, then gradually working back through
the latest **35 days**. Only exact contracts observed in available recent fills
are used. Expiries stay separate; a newly traded expiry is discovered automatically.

History requests have no streaming price subscription. Bar processing and saving
run in the background. A new fill or non-flat account defers further work; the
next account check also disposes an outstanding history request. Provider work
already underway cannot be guaranteed to stop instantaneously.

Keep NinjaTrader open while it catches up. If you close it, saved progress resumes
next time. Empty responses and provider failures retry later and do not become
invented candles or a claim of complete coverage. Available history depends on
your provider; this is not a full-year historical-price downloader.

Chrome uploads recorded candles automatically in small retryable batches, after
execution uploads. Older daily files are discovered about every **10 minutes**;
**Sync now** forces a folder discovery. Saved candles follow the private journal
across browsers and devices. Local candles remain usable if the cloud is offline.
New cloud prices appear when a chart opens or refreshes, about once a minute.

## Settings and recovery

- **Sync now** reads saved files, retries execution uploads, refreshes account
  snapshots and reloads journal views. It cannot force NinjaTrader to create a
  newer snapshot or bypass the history recorder's idle guard.
- The **Automatic journal sync** switch also pauses candle uploads. Existing
  cloud data remains available for review.
- Optional **continuous** candle collection uses the manually configured contracts
  and up to seven days of initial history. It adds platform work and takes
  precedence over automatic idle catch-up. Leave it off for normal use.
- Simulator mode keeps its **simulator-v1** folder. Simulator fills cannot enter
  prop-account results. Market candles remain separate from financial records.
- A clean **Stop and save** drains queued fills and refreshes companion CSVs.
  Warnings, queue saturation or uncertain timestamps require source review.
  Recovery is limited to executions NinjaTrader still exposes; use a native
  execution export for older missing fills.

## What is still separate

TradingView drawings, hand-drawn trendlines and strategy labels are not captured.
Price gaps remain missing where the provider supplies no candles. The chart
does not fill them with execution prices or assign a strategy automatically.

This source passes C# syntax and passive API checks, but the validation environment
has no NinjaTrader Windows assemblies. **F5 compilation and a platform responsiveness
comparison are still needed on your installation.** No new real-account test trade
is necessary. Check existing fills, snapshots and candles against NinjaTrader.

The recorder has no order submission, modification, cancellation, copying,
flattening, network client or embedded credentials. Financial results, firm
confirmations and payout records retain their separate meanings.

Private journal: https://journal.example.test
