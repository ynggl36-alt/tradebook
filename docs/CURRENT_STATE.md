# Current state

## Baseline

- Initial shared source prepared on 2026-10-19 from the owner's working Tradebook Site.
- Five primary sections: Accounts, Calendar, Analysis, Payouts & costs, Settings.
- Native balances and P&L remain prominent. Dated firm figures and execution-derived estimates remain separately labeled.
- Accounts use compact, responsive cards with five per row at desktop widths of 1440px and above. Funded, evaluation and unclassified accounts have separate sections. Funded sorting uses known qualifying days remaining, not a claim of payout eligibility; unknown cycles follow known progress. Evaluations sort by consistency-adjusted profit remaining, with unconfirmed targets last. Archived labels remain excluded by default.
- FIFO realized accounting includes partial exits, per-fill fees, session grouping and checkpoint uncertainty.
- Immutable account observations support conservative balance-adjustment detection, payout overlap checks and owner classification.
- Payout estimates use 90% for recognized Lucid Flex 50K funded accounts. Inference never writes confirmed cash received or fabricates an approval reset.
- Existing 0.4.1 recorder source captures NQ, MNQ, ES and MES executions; candle collection is optional.
- The first GitHub snapshot replaces all owner histories/identifiers with synthetic fixtures and empty deployment defaults. Source-data boundaries differ from the private Site and must be preserved by the release adapter.

## Ownership

- Publisher: original owner Tradebook conversation.
- Second session: contributor and reviewer, using its own task branches.
- Neither session has an exclusive GitHub identity when both use the owner's connected account. No automatic deployment or protected-branch enforcement is assumed.

## Work queue

No feature task is assigned merely by connecting a second session. The owner assigns each next task; record its scope in a PR. Avoid simultaneous schema/accounting edits unless the file ownership is explicit.

## Limits

- The public repository does not provide production trading data to either session. Analysis of actual records requires separate owner-authorized journal access.
- Balance inference depends on captured observations and execution coverage. Gaps and uncertain deductions remain visible; it cannot reconstruct absent historical cash observations.
- Long-retention performance of the full balance-interval scan has not been validated at year-scale.
- Managed Work browser preview requires the control-browser skill. Do not improvise a browser when the Sites skill says to skip it.
