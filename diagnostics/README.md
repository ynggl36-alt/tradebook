# Temporary account restriction diagnostic

This is an indicator for one chart, separate from TradebookRecorder. It inspects all connected Lucid LFE/LFF accounts, regardless of which account is selected on that chart. Your recorder can keep running.

It makes no trading, lockout, profile, financial or website changes. It does not classify failures, hide accounts, issue test orders, use a network client, read local logs, write report files, request prices or poll on ticks. Removing the indicator ends its event subscriptions.

## Run once

1. In NinjaTrader Control Center, open **New → NinjaScript Editor**.
2. Right-click **Indicators → New Indicator**. Name it **TradebookAccountDiagnostic**, finish the wizard and open the source.
3. Replace that new indicator's entire source with [TradebookAccountDiagnostic.cs](TradebookAccountDiagnostic.cs), then press **F5** to compile. Do not replace TradebookRecorder.
4. Open **New → NinjaScript Output** and select **Output 2**. If it contains unrelated text, use its context menu to clear that output first.
5. On one existing connected chart, open **Indicators**, add **TradebookAccountDiagnostic** once and apply it. The chart's instrument/timeframe does not choose which accounts are inspected. No position or new market tick is needed for the initial report.
6. Copy the lines from `[Tradebook diagnostic] ... BEGIN` through `INITIAL END`, plus any later diagnostic lines already present. Send them privately in the owner chat, identifying a known blown account, a healthy account and any account using your personal profit lockout. Missing examples are fine; do not deliberately trade, trigger a lockout, or reconnect to generate evidence.
7. Remove **TradebookAccountDiagnostic** from the chart when the report is captured. It can be re-added for a fresh report. No NinjaTrader restart is needed.

The output contains account identifiers and possibly native rejection messages. **Do not post it in the public GitHub issue or PR.** Share the lockout feature/add-on name privately as well.

## What the report means

- **Account.public:** a bounded discovery of public scalar properties/fields whose names concern status, risk or restrictions. Optional fields are feature-detected; complex objects, private members and credential-like names are not read. Values are recorded verbatim. An unfamiliar flag is not a supported failure API or a verified interpretation of its meaning.
- **AccountStatusUpdate:** raw future native events after attachment. The initial schema lists possible enum values when exposed; it does not pretend an event has already occurred. Generic connection state does not establish trading permission.
- **Loaded-order sample:** at most 200 already-loaded orders per account and three rejected examples. These are existing orders, never new submissions. A persisted order may not retain its original rejection reason. The sample is incomplete and zero matches proves nothing.
- **OrderUpdate rejected:** raw reason/error metadata from any rejection that already occurs while the indicator is attached. This never instructs the user to place a test order.
- **UNKNOWN:** no cause is inferred. A personal profit lock, DLL, administrative pause, margin restriction and failed account may expose overlapping flags or no useful desktop metadata. Permanent failure must not be inferred from any rejection or lock flag alone.

Output is capped at 250 report lines plus one limit notice, with at most 50 account subscriptions and 24 metadata members per inspection. There is no website upload or API integration in this diagnostic. Runtime checking against the owner's NinjaTrader Windows installation is required; source parsing and static checks do not establish provider behavior or native compilation.

## Source validation

Run `python tools/check-account-diagnostic.py` with the same optional tree-sitter/tree-sitter-c-sharp validation dependencies used by `tools/check-recorder.py`. These are validation-only dependencies, not indicator dependencies.

Official surfaces checked October 22, 2026:

- https://docs.ninjatrader.com/ninjascript/accountstatusupdate
- https://docs.ninjatrader.com/ninjascript/orderupdate
- https://docs.ninjatrader.com/ninjascript/orders
- https://docs.ninjatrader.com/ninjascript/onstatechange

The separate NinjaTrader/Tradovate backend risk API is not called and its availability through the owner's connection/login has not been established.
