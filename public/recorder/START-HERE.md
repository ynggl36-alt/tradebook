# Tradebook recorder 0.4.1 — light mode

This replaces your existing TradebookRecorder source. It uses the same
**accounts-v2** folder and preserves your saved executions and price archives.
No executable installer, extra broker connection or login is needed.

## Install once, when you have finished trading

1. In the old recorder, click **Stop and save**, wait until it says stopped,
   then close its window. Keep your saved folder and files.
2. Open **New → NinjaScript Editor → AddOns → TradebookRecorder**.
3. Open the new **TradebookRecorder.cs** in a text editor and copy the entire
   file. In the existing NinjaScript tab press **Ctrl+A**, paste, save and
   press **F5**. Replace the whole source; do not create a second AddOn.
4. Open **New → Tradebook recorder**. The heading must say **0.4.1**. If it
   still says 0.3.0, restart NinjaTrader outside your trading session.
5. Keep **Connected accounts — read-only** and your **LFE; LFF** prefixes.
   Executions automatically include **NQ, MNQ, ES and MES**, across expiries.
   The contract boxes select optional candle data only; at most two candle
   contracts are requested. Existing settings are retained.
6. Leave **Also collect one-minute prices** unchecked for the lowest load.
   Click **Start recording**. Leave the recorder open or minimized.
7. Refresh Tradebook in Chrome. Keep the existing **accounts-v2** folder
   connection and journal sync enabled. Grant folder permission if requested.
   Allow about **1–2 minutes** for a new account snapshot.

The source bundle is a readable ZIP, not a NinjaScript Import archive.

## Manual and automatic website updates

The **Sync now** button in the website header scans the connected saved folder,
retries allowed uploads, refreshes account snapshots and reloads journal views.
One manual refresh runs at a time. It preserves a paused upload setting and
cannot force NinjaTrader to produce a newer snapshot.

The website checks for cloud journal changes about once a minute while visible,
or every two minutes in the background, and reloads history only when changed.
Folder checks still run about every 30 seconds while visible. Browser throttling
can delay background timers. Snapshot timestamps remain the source of freshness.

**Realized exits** in the calendar includes partial closes, using a FIFO
execution model before commissions. **Completed trades** retains the existing
flat-to-flat trade statistics. The latest platform comparison shows the separate
NinjaTrader realized report and the execution estimate. Missing history or
unsupported fees remain visible rather than being filled with guesses.

## What light mode changes

- Detailed monitoring includes only matching **connected** accounts. Old,
  disconnected account objects are skipped. The status shows monitored and
  skipped counts; this is connectivity, not a prop-firm approval/status check.
- New connections/accounts are discovered automatically, using account-status
  notifications plus a 30-second fallback. Their available session executions
  are reconciled after discovery; existing journal history remains separate.
- Fill callbacks copy the event's values to a bounded background queue. XML
  formatting, timezone conversion and file writing happen on the writer.
- Available executions are checked about once a minute. Unchanged collections
  are not repeatedly copied in full; a full fallback runs about every five
  minutes. A disconnect and a clean stop trigger final recovery passes.
- Changed daily XML files save about every **10 seconds**. Balances and positions
  refresh about every **60 seconds**. Companion CSV exports refresh on a clean
  **Stop and save**, instead of being rewritten during normal capture.
- Chrome normally checks the account snapshot plus today's and yesterday's
  files about every **30 seconds**, or about a minute in the background. A full
  folder discovery runs about every ten minutes. **Check now** forces discovery
  immediately, including older files changed after a reconnect.
- An unchanged balance heartbeat does not reload every cached execution and
  receipt. Account calculations are cached between journal updates.

Recording still happens locally when Chrome is closed. Saved fills catch up
when you reopen Chrome with folder access. Account snapshots have their own
capture times; they are not tick-by-tick balances. Recorder 0.4.1 snapshots become
**Last known** after about three minutes without a new running heartbeat, or
immediately when a stopped snapshot reaches the website.

## Optional price collection

Light mode records **executions, balances and positions**, with prices off.
Existing chart archives remain available. New candle charts require price data
from optional collection or a later historical-price import.

If you need local candles, stop and save, check **Also collect one-minute
prices**, and restart. **0 days back** requests today's data and then records
new completed one-minute candles. You can explicitly request up to seven days
for historical context; that backfill adds load and is better done outside your
trading session. Only the configured exact contracts are collected.

Minute bars remain separate from your account results. Simulation mode still
uses **simulator-v1** and cannot upload simulator trades as prop-account trades.

## First comparison

- The recorder should list only connected matching accounts, with old account
  objects counted as skipped. Compare the names with NinjaTrader's Accounts tab.
- Compare reported cash values, net liquidation and positions with NinjaTrader.
  Missing provider fields remain **Not supplied**; initial unsupported zeros
  are not treated as known balances.
- Confirm that a completed trade's execution IDs, quantities and prices match
  NinjaTrader. Repeated IDs should be recognized as duplicates in Tradebook.
- Compare platform responsiveness with the same workspace. If significant lag
  remains, stop recording and note whether it occurs at startup, periodically,
  or continuously; also compare with the Tradebook tab closed.

No real-account test trade is required. Use existing session executions or
Sim101. This source has passed C# syntax/architecture checks and the website's
compatibility tests. **It has not been compiled against NinjaTrader's Windows
assemblies or performance-tested on your computer.** The F5 compilation and
platform comparison remain necessary.

## Capture limits

The ten-second save interval trades some disk activity for a longer unsaved
window if NinjaTrader or Windows crashes. A clean stop drains queued records
and attempts final session recovery before saving. Queue saturation, writer
errors and uncertain executions are surfaced as warnings; recovery is limited
to what NinjaTrader still exposes. Do not assume an incomplete run is complete.
If the recorder was off, recover missing executions through NinjaTrader's
available session collection or a native execution export.

The recorder contains no order submission, modification, cancellation,
flattening or copying commands, no network client and no embedded credentials.
Balances, firm records, payouts and bank confirmations keep their separate
meanings. This update does not modify execution prices or trading P&L.

Private journal: https://journal.example.test
