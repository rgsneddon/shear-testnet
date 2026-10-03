#!/usr/bin/env python3
"""Move public nginx :443 to loopback :8443 so stream preread can own :443.

Dry-run prints the rewritten listen lines. --apply is for the pool host.
"""
import os
import sys

SKIP_DIRS = {"bak", "backup"}


def rewrite_listen_line(line):
    body = line
    nl = ""
    if body.endswith("\n"):
        nl = "\n"
        body = body[:-1]
    stripped = body.strip()
    if not stripped.startswith("listen ") or "8443" in stripped:
        return line
    if "443" not in stripped:
        return line
    updated = body.replace("[::]:443", "[::1]:8443")
    updated = updated.replace("listen 443", "listen 127.0.0.1:8443")
    if updated == body:
        return line
    return updated + nl


def rewrite_text(text):
    return "".join(rewrite_listen_line(line) for line in text.splitlines(keepends=True))


def main(argv):
    if "--self-test" in argv:
        sample = "    listen 443 ssl; # managed by Certbot\n    listen [::]:443 ssl ipv6only=on;\n    listen 80;\n"
        out = rewrite_text(sample)
        assert "listen 127.0.0.1:8443 ssl;" in out, out
        assert "listen [::1]:8443 ssl ipv6only=on;" in out, out
        assert "listen 80;" in out, out
        again = rewrite_text(out)
        assert again == out
        print("REWRITE_OK")
        return 0
    root = argv[1] if len(argv) > 1 else "/etc/nginx/sites-enabled"
    apply = "--apply" in argv
    changed = 0
    for name in sorted(os.listdir(root)):
        path = os.path.join(root, name)
        if not os.path.isfile(path):
            continue
        raw = open(path, encoding="utf-8", errors="replace").read()
        nxt = rewrite_text(raw)
        if nxt == raw:
            continue
        changed += 1
        print("REWRITE", name)
        if apply:
            with open(path, "w", encoding="utf-8", newline="\n") as f:
                f.write(nxt)
    print("CHANGED", changed, "APPLY" if apply else "DRY")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
