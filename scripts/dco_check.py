#!/usr/bin/env python3
"""Developer Certificate of Origin check: every non-merge commit in BASE..HEAD
must carry a "Signed-off-by:" line naming its author's email.

Commits whose parent predates this check (the parent tree has no
.github/workflows/dco.yml) are exempt, so history from before the DCO was
adopted is never asked to be rewritten.

Usage: dco_check.py BASE HEAD
"""
import re
import subprocess
import sys

WORKFLOW = ".github/workflows/dco.yml"
SIGNOFF = re.compile(r"^Signed-off-by:\s*(.+?)\s*<([^>]+)>\s*$", re.M)


def git(*args):
    return subprocess.run(("git",) + args, check=True, capture_output=True, text=True).stdout


def has_workflow(rev):
    return subprocess.run(("git", "cat-file", "-e", f"{rev}:{WORKFLOW}"), capture_output=True).returncode == 0


def problems(base, head):
    out = []
    for line in git("rev-list", "--reverse", "--no-merges", "--parents", f"{base}..{head}").split("\n"):
        if not line:
            continue
        sha, *parents = line.split()
        if not parents or not has_workflow(parents[0]):
            continue
        email = git("show", "-s", "--format=%ae", sha).strip().lower()
        signers = {m.group(2).strip().lower() for m in SIGNOFF.finditer(git("show", "-s", "--format=%B", sha))}
        if email not in signers:
            subject = git("show", "-s", "--format=%s", sha).strip()
            out.append(f"{sha[:12]} {subject!r}: no 'Signed-off-by:' for author <{email}>")
    return out


def main(argv):
    if len(argv) != 3:
        sys.exit(__doc__)
    bad = problems(argv[1], argv[2])
    for p in bad:
        print(p)
    if bad:
        print("\nSign off with `git commit -s` (see CONTRIBUTING.md). To fix existing commits: "
              "git rebase --signoff " + argv[1])
        return 1
    print("DCO ok")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
