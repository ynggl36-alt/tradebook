# Publishing a reviewed change

Only the designated publisher performs this process. GitHub Actions checks code; it has no deployment token, database binding credentials or automatic publishing step.

1. Confirm the owner-requested scope, review the PR, merge one change at a time and identify the exact reviewed `main` commit. Use a clean GitHub checkout of that commit.
2. Open the existing owner-private Site using the Sites skill. Reuse its exact project ID, current source and audience. Do not create a new Site and do not alter access to solve repository access problems.
3. Check that both checkouts are clean. Record live execution/payout counts and download a private journal backup for material data changes.
4. Run the release adapter in plan mode:

   ```sh
   node tools/prepare-release.mjs --source /path/to/clean/github-checkout --target /path/to/opened/sites-checkout
   ```

   It rejects data-bearing GitHub seeds and preserves the target's hosting manifest, initial history and firm notices. For the first release, it extracts the existing literal notice array from the original private source without uploading it.
5. Apply that reviewed copy with the same command plus `--apply`. This only edits the owner-controlled checkout; it does not publish or contact the hosted database.
6. Run the public-source guard in the GitHub checkout, then tests, type checking and build in the prepared Sites checkout. Confirm private files still have the expected source data and no demo records enter production. Generate only appended Drizzle migrations when needed.
7. Use the Sites source helper with that Site's credential/opening result to check/build, commit/push the prepared private source and package it. Publish the exact result owner-private through Sites.
8. Verify deployment success, unchanged source financial records and any specific behavior changed. Record the GitHub commit and Site version/deployment in the owner conversation or private release notes. A GitHub push alone never updates the website.

## Do not copy these from GitHub over production

- `.openai/hosting.json` — the public version has no Site project ID.
- `data/initial-history.json` — the public version is an empty installation seed.
- `data/firm-adjustments.json` — the public version is empty; actual notices are private owner data.

The adapter preserves these three files. It does not restore production data from GitHub, rewrite cash/fills, or apply hosted migrations on its own. Stop on an unexpected checkout state or missing private release inputs and resolve that concrete issue before publishing.
