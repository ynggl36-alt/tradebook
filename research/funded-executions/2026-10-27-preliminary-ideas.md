# Preliminary funded execution ideas

**Status: parked.** The owner asked on 2026-10-28 to preserve these ideas and move to a separate problem. Do not start a trading pilot, change the website, configure lockouts or implement filters simply because these notes exist.

## Research context

The private study dated 2026-10-27 examined recorded 2026 funded executions through completed sessions on 2026-10-26. Evaluations and unclassified accounts were excluded. The detailed report is titled **Tradebook · Funded execution insights** and is retained privately with the owner.

The study screened execution fills, checked completed-position allocations and retained account-sessions only when inventory coverage and position-to-fill gross arithmetic reconciled. Some account-sessions remained incomplete. Therefore its totals describe an auditable subset, not complete annual account performance, payouts or business profit.

Older historical fees and other-firm fees were not assumed to be zero. The broad study used gross results; a separate recent Lucid cohort used known scheduled fees. Neither cohort should be silently substituted for the other.

## Ideas to revisit

| Idea | Preliminary interpretation | Validation needed |
| --- | --- | --- |
| Later-morning entry window | Recent Lucid results suggested investigating 09:30–11:00 America/Chicago, equivalent to 10:30–12:00 New York. The pattern was weaker in older pooled funded history. | Recheck by instrument, size, market conditions and matched account-session; validate prospectively. |
| Restrained Nasdaq size | Larger reconstructed NQ/MNQ positions showed a weaker historical payoff. A candidate comparison boundary was 1 NQ or 10 MNQ equivalent per position. | Distinguish per-position maximum size from combined account exposure; account for volatility, stop distance and remaining firm loss allowance. This boundary is not an established optimal or safe limit. |
| Underwater additions | Adding after an adverse move was a behavior worth examining. | Separate planned scaling from unplanned risk expansion. Check sizing and market-condition confounders; avoid inferring intent from execution timing. |
| Loss concentration across accounts | Losses clustered across multiple funded accounts on some dates. | Assess day-wide exposure alongside individual-account safeguards. The previously discussed lockout scope was the affected account only; no broader lockout was authorized. |
| Fees and trading volume | A small gross advantage can be consumed by scheduled costs. | Compare net only when fee coverage is known; evaluate marginal entries and turnover without selecting arbitrary thresholds after seeing results. |
| High position counts | Later positions in busy recent sessions were a warning candidate, but a fixed count cutoff did not hold uniformly across the year. | Test position count alongside time, size and market context before considering a hard ceiling. |
| Losing streaks and quick re-entry | The study did not establish that two completed losses or re-entry within 60 seconds are sufficient reasons to block the next entry. | Keep capital-protection rules separate from claims about entry quality. Rapid re-entry alone does not identify revenge trading. |
| Direction | Recent long/short differences were not stable across the full history. | Do not infer a permanent long-only rule; evaluate market context and a later held-out period. |

## Definitions and interpretation limits

- A completed position is a flat-to-flat episode in one contract. Multiple entry fills, scaling and partial exits belong to that episode. Separate NQ and MNQ episodes are not necessarily separate discretionary setups.
- Entry clocks use America/Chicago with daylight-saving changes. The futures-session boundary is 17:00 Chicago; it is separate from a calendar date.
- The exploratory underwater-add detector required another entry at least 10 seconds after the first, with price at least one point adverse to the remaining average entry. Those thresholds reduce instant-fill noise; they are not validated strategy definitions or automatic trading rules.
- Booked P&L and earlier completed losses used only events before the new entry. Booked results do not measure floating drawdown or complete account risk.
- Positions and accounts on the same date are not independent observations. The study used date-cluster resampling, chronological splits and exclusion of extreme dates. Those checks reuse historical data and do not replace prospective validation or correct for every comparison examined.
- The apparent time-window advantage was less decisive in comparisons within the same account-session. Selection of which sessions continue into later hours remains a confounder.
- No reliable full-year setup labels were established. Time and size patterns do not prove whether weekly-gap bounces, trendline touches or momentum entries are profitable. Missing older contract-price archives also limit full-year floating-equity analysis.
- Specific daily-loss and profit-giveback settings belong to the separate risk study. Nothing in this note approves or activates a threshold.

## Possible resumption plan

If the owner returns to this topic, first recover the private report and refresh the data-coverage audit. Do not reconstruct its exact results from this sanitized note.

The proposed next research step was a prospective pilot over 20 completed funded trading dates, with rules frozen in advance: investigate the later-morning window, restrained Nasdaq exposure and no unplanned expansion of underwater risk. The pilot has not started and requires a renewed owner request. Preserve actual execution history, review exceptions explicitly and evaluate outcomes after known costs.

Keep unrelated application fixes in their own tasks. In particular, historical capture-roster validation follow-up [#35](https://github.com/ynggl36-alt/tradebook/issues/35) is separate from strategy research.
