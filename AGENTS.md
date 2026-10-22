# Instructions for every ChatGPT/Codex session

## Ownership and isolation

- Read this file, `docs/CURRENT_STATE.md` and `docs/COLLABORATION.md` before edits.
- Read the latest checkpoint in [coordination issue #21](https://github.com/ynggl36-alt/tradebook/issues/21), its comments and the linked task/PR before taking over. Record your claim before editing; another active writer must explicitly stop or be reassigned by the owner.
- The original owner conversation is the initial publisher. Other sessions are contributors unless the owner explicitly reassigns the publisher role. Only one session publishes at a time.
- Work in your own clone/worktree and unique branch (`agent/<session>/<task>`). Never share a writable checkout with another active session.
- Use one focused pull request per task. Announce scope in its description and task record. Check open pull requests before editing shared accounting, importer or schema files.
- Never commit directly to `main` after initial setup, force-push `main`, reset another agent's work, or merge unrelated changes.
- Both sessions may authenticate as the same GitHub user. A second session's review is documented in the PR, but is not a separate GitHub identity or an enforceable independent approval.
- Update branch references with the expected current SHA. If that lease fails, inspect the new head and integrate it; never overwrite it.

## Validation and review

- Run `node tools/check-public-source.mjs`, `node tools/test.mjs`, type checking and a production build for relevant changes.
- CI has no production secrets or access to the hosted journal. Test only synthetic fixtures and isolated databases.
- Run meaningful regressions for financial, importer, snapshot and migration changes. Do not write tests that only repeat implementation details.
- Resolve conflicts locally, rerun checks against the latest `main`, and merge one reviewed PR at a time.
- Report checks actually run and any verification limits. Never claim browser checks or independent identity approval that did not happen.

## Data invariants

- Keep raw executions, stable trade IDs, reviews, firm confirmations and dated source evidence intact.
- Never turn an unexplained deduction into a confirmed receipt, or count the same payout twice.
- Keep reported balances/P&L distinct from execution estimates and gross trading profit distinct from business proceeds/costs.
- Missing fees, inventory, position observations and approval ordering remain explicitly unknown.
- Keep actual records, account IDs, screenshots, bank files, tokens, database dumps and the owner's private Git history out of this repository, even if it later becomes private.
- `data/initial-history.json` must remain an empty installation seed and `data/firm-adjustments.json` must remain `[]` here. Use synthetic fixtures under `tests/fixtures/`.

## Publishing and database changes

- Contributors do not call Sites publishing tools, edit production data, change account access or add deployment credentials to GitHub.
- The publisher follows `docs/RELEASING.md`, preserves the current Site's identity/audience/private data, and uses the Sites helper for hosted source opening, commit/push and packaging.
- Do not deploy this sanitized checkout directly over the live Site. Use `tools/prepare-release.mjs` to preserve the owner's private deployment manifest, seed and firm notices.
- Schema changes require an updated Drizzle schema and newly generated, appended migrations. Never rewrite applied migrations or create tables in request handlers.
- Coordinate schema changes in sequence; two sessions must not generate competing migration numbers.
- GitHub Actions never auto-deploys. Keep code publication separate from the owner's live journal publication.

## Handoff

Each PR description must state the problem, changed behavior, files/areas owned, validation, migration needs and remaining limitations. Update `docs/CURRENT_STATE.md` when behavior or the release process changes. Read task/PR context in the next session instead of assuming it shares this conversation's memory.

- Use issue #21 as the shared coordination index and the task issue or draft PR as its detailed progress log. Follow the checkpoint template in `docs/COLLABORATION.md`.
- Checkpoint at task start, meaningful milestones, before long operations, and before pausing or ending a turn. During extended investigation, aim to save a checkpoint every 5–10 minutes. Do not depend on an advance usage-limit warning.
- Preserve the owner's request, decisions, scope, branch, exact pushed commit, completed work, validation actually run, remaining problems, approaches already tried and exact next action. Save safe unfinished code to the task branch as WIP; do not merge or deploy it merely to finish a handoff. Explicitly identify work that is not pushed or is only locally available.
- Record pushed, reviewed, merged and deployed states separately. Deployment entries identify the target Site, reviewed public commit and exact Site version; private records, credentials and private repository history stay out of GitHub.
- Before stopping, mark whether ownership is released and leave a resumable next step. Silence or an old timestamp alone is not permission to take over. A handoff does not extend task authorization or transfer the publisher role.
