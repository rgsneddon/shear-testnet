import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export function sha256(text) {
  return crypto.createHash('sha256').update(text).digest('hex');
}

/** Tag skeleton with visible text removed. Inline style is returned separately. */
export function pageFingerprint(html) {
  const styles = [];
  const withoutStyle = String(html).replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, (block) => {
    styles.push(block);
    return '<style></style>';
  });
  const withoutScript = withoutStyle.replace(/<script\b([^>]*)>[\s\S]*?<\/script>/gi, (_all, attrs) => {
    return `<script${attrs}></script>`;
  });
  const skeleton = withoutScript
    .replace(/>([^<]+)</g, (_all, text) => (text.trim() ? '> <' : '><'))
    .replace(/\s+/g, ' ')
    .trim();
  return {
    skeleton: sha256(skeleton),
    style: sha256(styles.join('\n')),
  };
}

/** Class, id, and tag names from a chrome script. Label strings are not part of the lock. */
export function chromeFingerprint(source) {
  const classes = [...String(source).matchAll(/class="([^"]*)"/g)].map((m) => m[1]);
  const ids = [...String(source).matchAll(/\sid="([^"]*)"/g)].map((m) => m[1]);
  const tags = [...String(source).matchAll(/<([a-zA-Z][\w-]*)\b/g)].map((m) => m[1].toLowerCase());
  return sha256(JSON.stringify({ classes, ids, tags }));
}

export function fileSha(absPath) {
  return sha256(fs.readFileSync(absPath));
}

export function collectCss(repoRoot) {
  const roots = ['site', 'pool/public', 'pool/admin', 'explorer', 'mempool', 'dag'];
  const out = [];
  function walk(relDir) {
    const abs = path.join(repoRoot, relDir);
    if (!fs.existsSync(abs)) return;
    for (const name of fs.readdirSync(abs)) {
      const rel = path.posix.join(relDir.replace(/\\/g, '/'), name);
      const full = path.join(repoRoot, rel.split('/').join(path.sep));
      if (fs.statSync(full).isDirectory()) walk(rel);
      else if (name.endsWith('.css')) out.push(rel.split(path.sep).join('/'));
    }
  }
  for (const root of roots) walk(root);
  out.sort();
  return out;
}

export function collectChrome(repoRoot) {
  const roots = ['site', 'pool/public', 'explorer', 'mempool', 'dag'];
  const names = new Set(['shear-chrome.js', 'theme.js']);
  const out = [];
  function walk(relDir) {
    const abs = path.join(repoRoot, relDir);
    if (!fs.existsSync(abs)) return;
    for (const name of fs.readdirSync(abs)) {
      const rel = path.posix.join(relDir.replace(/\\/g, '/'), name);
      const full = path.join(repoRoot, rel.split('/').join(path.sep));
      if (fs.statSync(full).isDirectory()) walk(rel);
      else if (names.has(name)) out.push(rel.split(path.sep).join('/'));
    }
  }
  for (const root of roots) walk(root);
  out.sort();
  return out;
}

export function buildLock(repoRoot) {
  const manifest = JSON.parse(fs.readFileSync(path.join(repoRoot, 'site', 'snapshot-manifest.json'), 'utf8'));
  const pages = {};
  for (const row of manifest.pages) {
    const rel = row.file.replace(/\\/g, '/');
    if (pages[rel]) continue;
    const html = fs.readFileSync(path.join(repoRoot, rel.split('/').join(path.sep)), 'utf8');
    pages[rel] = pageFingerprint(html);
  }
  const css = {};
  for (const rel of collectCss(repoRoot)) {
    css[rel] = fileSha(path.join(repoRoot, rel.split('/').join(path.sep)));
  }
  const chrome = {};
  for (const rel of collectChrome(repoRoot)) {
    const src = fs.readFileSync(path.join(repoRoot, rel.split('/').join(path.sep)), 'utf8');
    chrome[rel] = chromeFingerprint(src);
  }
  return { pages, css, chrome };
}
