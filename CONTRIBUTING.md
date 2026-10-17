# Contributing to Shear

Shear is released under the MIT License ([LICENSE](LICENSE)). The copyright
holders are the Shear contributors: each contributor keeps the copyright in
their own contribution and licenses it under the MIT License.

## Developer Certificate of Origin

Every commit must be signed off under the
[Developer Certificate of Origin 1.1](https://developercertificate.org/),
reproduced below. Signing off means adding a line like this to the commit
message, with your real name and the email address the commit is authored
with:

```
Signed-off-by: Jane Doe <jane@example.com>
```

`git commit -s` adds it for you. To sign off commits you have already made on
a branch, run `git rebase --signoff <base>`.

The `dco` workflow ([.github/workflows/dco.yml](.github/workflows/dco.yml))
checks every commit in a pull request and fails if one has no sign-off from
its author. Commits made before the check was added are exempt. You can run
the same check locally with `python3 scripts/dco_check.py <base> HEAD`.

```
Developer Certificate of Origin
Version 1.1

Copyright (C) 2004, 2006 The Linux Foundation and its contributors.

Everyone is permitted to copy and distribute verbatim copies of this
license document, but changing it is not allowed.


Developer's Certificate of Origin 1.1

By making a contribution to this project, I certify that:

(a) The contribution was created in whole or in part by me and I
    have the right to submit it under the open source license
    indicated in the file; or

(b) The contribution is based upon previous work that, to the best
    of my knowledge, is covered under an appropriate open source
    license and I have the right under that license to submit that
    work with modifications, whether created in whole or in part
    by me, under the same open source license (unless I am
    permitted to submit under a different license), as indicated
    in the file; or

(c) The contribution was provided directly to me by some other
    person who certified (a), (b) or (c) and I have not modified
    it.

(d) I understand and agree that this project and the contribution
    are public and that a record of the contribution (including all
    personal information I submit with it, including my sign-off) is
    maintained indefinitely and may be redistributed consistent with
    this project or the open source license(s) involved.
```

## Third-party code and licences

Adding a dependency, vendored file, font or other asset changes what Shear
ships. Run `python3 scripts/licenses/notices.py generate` and commit the
regenerated notices; `notices.py check` (the `licenses` workflow) fails on a
copyleft or unknown licence, a missing licence text or stale notices. Font
files are not committed: see [docs/font-history-removal.md](docs/font-history-removal.md)
and `deploy/install_fonts.sh`. Background is in
[docs/licensing-audit.md](docs/licensing-audit.md).
