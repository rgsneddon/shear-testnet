# Removing the font files from git history

Status: **prepared, not run.** This is decision 1 in `docs/licensing-audit.md`. The font files were removed from the tree on 2026-10-14, but every earlier commit still contains them. Removing them from history rewrites every commit hash from the first font commit onward and needs a force-push of all branches and tags. **Russell must give an explicit GO before step 3.** No one has force-pushed or rewritten history for this yet.

## What is removed

All 56 `.otf`, `.ttf` and `.woff2` files of Nevia (Sentavio) and Urema Variable (Zafira Type) under `brand/`, `site/`, `site/boot/`, `explorer/`, `mempool/`, `pool/public/` and `team/`. They were added in `f0072e12`, `f67d2902`, `c8ee5713` and `76ea8e59`. The script removes only paths whose names contain Nevia or Urema and end in `.otf`, `.ttf`, `.woff`, `.woff2` or `.eot`. Great Vibes (`fonts/greatvibes/`, SIL OFL WOFF2) stays, and the survivor check ignores that directory.

The wordmark PNGs (`*wordmark-nevia*.png`) are rendered images, not font software, and stay.

## Effect of the rewrite

- Every commit from `f0072e12` onward gets a new hash on every branch that contains it. Commit hashes quoted in docs (for example in `docs/v12-HANDOFF.md`), PR descriptions, release notes and deployed version strings will no longer resolve.
- Open PRs need rebasing onto the rewritten branches; every clone must be re-cloned or hard-reset.
- GitHub keeps `refs/pull/*` (read-only) and cached objects. The old objects stay reachable by hash until GitHub Support removes them, so a support request is part of the procedure.
- Forks keep the files. They have to be asked to delete or re-fork.

## Procedure

1. Get Russell's GO. Announce a push freeze and list open PRs.
2. Prepare the rewrite in a scratch directory (no push):

   ```bash
   pip install git-filter-repo
   scripts/licenses/purge_font_history.sh /tmp/font-purge
   ```

   The script makes a mirror clone, records the font paths, runs `git filter-repo --invert-paths` for Nevia and Urema only, and fails if any font path outside `fonts/greatvibes/` survives. It does not push.
3. **After the GO only:** `cd /tmp/font-purge/shear-testnet.git && git push --force --mirror https://github.com/rgsneddon/shear-testnet.git`.
4. Ask GitHub Support to purge cached views and unreachable objects for the repository, and to drop the old `refs/pull/*` objects (see GitHub's "Removing sensitive data from a repository").
5. Tell collaborators to re-clone, rebase open PRs, and ask fork owners to delete their forks.
6. On a fresh clone, `git log --all --name-only --format= | grep -iE '\.(otf|ttf|woff2?|eot)$' | grep -viE '^fonts/greatvibes/'` is empty. `fonts/greatvibes/` is still there.

## Deployed sites

The sites keep self-hosting the WOFF2 webfonts under the webfont licence. `deploy/install_fonts.sh` copies them from the licensed package (`SHEAR_FONTS_DIR`, kept outside the repository) into each site's `brand/fonts/` at deploy time, and `deploy/rsync_de.sh` runs it when `SHEAR_FONTS_DIR` is set. `.gitignore` keeps them out of git.
