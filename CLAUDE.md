# Standing rules for agents in this repo (Russell, 30 Oct 2026)

- Every commit is signed off at commit time: `git commit -s`.
- Red test first, then the fix, at the root cause. No retry, no looser test, no skip, no bypass flag.
- Draft PRs only. No merge, deploy, cut, tag or `push --force` without Russell's GO.
- No host IPs, pids, machine paths or secrets in commits, PR bodies or logs.
- No tests on the laptop, p2p-a or p2p-b. Tests run on agent-box through its runner; long jobs detached, logs polled.
- When a task is truly finished (pushed, suites done, PR body updated), append ONE line to
  `agent-box:/root/claude-ci/handoff/DONE.jsonl` (`mkdir -p` the folder; append only, never rewrite):

  ```json
  {"ts":"<UTC ISO>","task":"<roadmap # / row>","pr":<n>,"branch":"<b>","tip":"<full sha>","base":"<sha>","summary":"<one line>","suite":"<before -> after>","files":["<main paths>"]}
  ```

  No line for WIP or partial pushes. No host IPs or secrets. CoS routes each line to the review lanes.
