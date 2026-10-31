# Standing rules for agents in this repo (Russell, 30 Oct 2026)

- Every commit is signed off at commit time: `git commit -s`.
- Red test first, then the fix, at the root cause. No retry, no looser test, no skip, no bypass flag.
- Draft PRs only. No merge, deploy, cut, tag or `push --force` without Russell's GO.
- No host IPs, pids, machine paths or secrets in commits, PR bodies or logs.
- No tests on the laptop. Tests run on a test host through its runner; long jobs detached, logs polled.
  Test hosts and their limits are listed in CLAUDE.local.md.
- Every PR must be mergeable into its base the moment it is done. Branch every task off the CURRENT
  tip of main (`git fetch` first), unless the task says it depends on another open PR; then base the
  PR on that branch and say so at the top of the PR body. Before writing a DONE line run
  `git fetch && git merge-tree --write-tree origin/<base> HEAD` (no conflicts) and
  `git diff origin/<base>...HEAD --stat` (only this task's files). If main moved and conflicts appear,
  merge `origin/<base>` into the branch with a `-s` merge commit (no rebase, no force-push), re-run the
  affected suite, then write the DONE line. Put "Mergeable into <base> at <base sha>: yes" in the PR
  body and in the DONE summary.
- When a task is truly finished (pushed, suites done, PR body updated), append ONE line to
  the handoff file named in CLAUDE.local.md (`mkdir -p` the folder; append only, never rewrite):

  ```json
  {"ts":"<UTC ISO>","task":"<roadmap # / row>","pr":<n>,"branch":"<b>","tip":"<full sha>","base":"<sha>","summary":"<one line>","suite":"<before -> after>","files":["<main paths>"]}
  ```

  No line for WIP or partial pushes. No host IPs or secrets. CoS routes each line to the review lanes.
  "Truly finished" means the agent's own work is done (pushed, suites done, body updated). It does not
  wait for Russell's sign-off, a merge or a deploy; those come after lane review. A PR whose consensus
  or pin change still needs sign-off gets its line when the work is done, with the open item named in
  `summary` (e.g. "levy.js node-side diff needs Russell sign-off").
