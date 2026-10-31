#!/usr/bin/env node
/**
 * Build the public roadmap page (site/roadmap/index.html) from docs/ROADMAP.md.
 *
 * Public-safe by construction. The build reads only the public table of
 * docs/ROADMAP.md, which carries exactly six columns (Priority, ID, Public
 * title, Type, Status, Ref); any other column, or a row with more cells, fails
 * the build. Every row carries a Ref (rf- and ten hex digits from a secure
 * random source), so the column says nothing about what a row is; each row's
 * detail lives in the maintainers' tracker (docs/ROADMAP.tracker.md,
 * gitignored, never committed). Every row needs a Public title:
 * NFKC-normalised, zero-width and fullwidth forms stripped, then plain ASCII
 * and clear of the deny-list, or the build fails. An ID is R, two digits and
 * an optional lower-case letter. A status outside the vocabulary fails the
 * build; done, closed, merged, shipped and deployed rows drop off. The whole
 * of docs/ROADMAP.md must carry no host detail. Same input, same bytes.
 *
 *   node scripts/build_roadmap_page.mjs                      # write the page
 *   node scripts/build_roadmap_page.mjs --check              # exit 1 if the page is stale
 *   node scripts/build_roadmap_page.mjs --write-deny-hashes  # re-hash the tracker's deny list
 *
 * The tracker's "Page deny list" (host and lane names, which no committed file
 * may carry) is committed only as salted hashes (docs/roadmap-deny.json). The
 * build always checks against those hashes and fails closed when they are
 * missing; when the tracker is present its terms are checked in plain too, and
 * the committed hashes must match them exactly.
 */
import { createHash, randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** The only columns the page may carry, in order. */
export const PUBLIC_COLUMNS = Object.freeze(['Priority', 'Row', 'Title', 'Status', 'Type']);

/** The public table of docs/ROADMAP.md: exactly these columns, in this order. */
const PUBLIC_TABLE = Object.freeze(['Priority', 'ID', 'Public title', 'Type', 'Status', 'Ref']);

/** The status vocabulary. The whole cell, after markdown, is one of these words; anything else fails the build. */
const STATUS_WORDS = Object.freeze({
  planned: 'planned',
  active: 'active',
  coding: 'active',
  'in review': 'in review',
  'awaiting go': 'awaiting GO',
  ruled: 'ruled',
  merged: 'merged',
  done: 'done',
  closed: 'closed',
  shipped: 'done',
  deployed: 'done',
});
const DROPPED_STATUS = new Set(['merged', 'done', 'closed']);

const ROW_ID = /^R\d{2}[a-z]?$/;
const REF = /^rf-[0-9a-f]{10}$/;

/** Machine-name shapes: name-box, name_soak, p2p-x, p2p_x, p2p x, namenode7. */
const MACHINE_SHAPE = /\b[a-z0-9]+[-_](?:box|soak|vps)\b|\bp2p[-_ ]?[a-z]\b|\b[a-z]+node\d+\b/i;

/**
 * Anything matching these must never reach the page: the build refuses. Every
 * pattern but the spaced-code one is case-insensitive and runs on the
 * normalised title. Host and lane names are not written here (no committed
 * file names a host); they are checked through the deny hashes.
 */
const UNSAFE = [
  /\b(?!v\d+[a-z]?\b|p2p\b|x(?:64|86)\b|arm64\b)[a-z]{1,4}[-_.]?\d{1,3}[a-z]?\b/i, // finding codes: H5, F-2, PA-3, SEC_12, H.5 (v12, P2P, x64, arm64 are not)
  /\b[A-Z]{1,3} \d{1,3}[a-z]?\b/, // spaced finding codes: PA 3, H 5
  /\bP[0-3]\b/i, // priority labels P0-P3
  /\b(?:critical(?:ly|ity)?|high(?:s|er|est)?|mediums?|low(?:s|er|est)?|sever(?:e|ely|ity|ities))\b/i, // severity words and their forms
  /\b(?:exploit|vuln|leak|bypass|grief|attack|flaw|weakness|breach|compromis|inject|overflow|underflow|forg(?:e|ed|es|ing|ery|eries)\b|spoof|hijack|backdoor|malicious|insecur|unsafe|harden|secur|steal|stole|theft|tamper|malleab|grind|d?dos\b|denial[\s-]of[\s-]service)/i, // exploit, attack and flaw words
  /\bCVE-\d{4}-\d{4,}\b/i, // CVE ids
  /\b(?:lanes?|auditors?|assailants?|evaluat(?:ors?|ions?)|reviewers?|red[\s-]?team(?:s|ing)?|pen[\s-]?test(?:s|ing|ers?)?)\b/i, // lane roles and their forms
  /\bprivate\b/i, // the page never says a row is private
  /\b(?:[a-z0-9-]+\.)+(?:digital|com|net|org|io|dev|app|xyz|de|uk)\b/i, // host names: domains
  MACHINE_SHAPE, // host names: machine-name shapes
  /\b\d{1,3}(?:\.\d{1,3}){3}\b/i, // IPv4
  /\b[0-9a-f]{0,4}(?::[0-9a-f]{1,4}){3,}\b/i, // IPv6-ish
  /\b(?:pid|port)\s*[=:]?\s*\d{2,}\b/i,
  /\/root\/|\/home\/|[A-Z]:\\/i, // machine paths
  /\b[\w.-]+(?:\/[\w.-]+)+\.(?:js|mjs|cjs|ts|dart|rs|c|h|md|json|html|css|sh|py|toml|yml|yaml)\b(?::\d+)?/i, // repo file paths
  /\b[\w-]+\.(?:js|mjs|cjs|ts|dart|rs|c|h)\b:\d+/i, // file:line
  /[\w.+-]+@[\w-]+(?:\.[\w-]+)+/i, // emails
  /\b(?:Russell|Grok|Claude|GPT|CoS)\b/i, // owner notes name agents
  /\bDesktop\b|\bhandoff\b/i, // design files and handoff notes
  /\b(?:ssh|hetzner|vps|contabo)\b/i,
  /\bPRs?\s*#?\d+[a-z]?\b/i, // PR labels
  /\bGoals?\s*\d+/i, // Goal labels
  /github\.com|pull\/\d+|#\d{2,}/i, // PR internals
];

/** Host detail the whole of docs/ROADMAP.md may not carry (names come through the deny hashes). */
const HOST_DETAIL = [
  MACHINE_SHAPE,
  /\b(?:hetzner|contabo|ovh|digitalocean|linode|vultr|vps)\b/i, // providers
  /\bDesktop\b/, // design notes on a laptop
  /\/root\/|\/home\/|\b[A-Z]:\\/, // machine paths
  /\b\d{1,3}(?:\.\d{1,3}){3}\b/, // IPv4
];

function stripMarkdown(s) {
  return String(s)
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\*\*|__|`/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** NFKC, then zero-width and other format characters and leftover fullwidth forms out. */
function normalise(s) {
  return String(s)
    .normalize('NFKC')
    .replace(/[\p{Cf}\uFF00-\uFFEF]/gu, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** The Public title cell, normalised before any whitespace rule (U+FEFF counts as whitespace). Empty is not a title. */
export function publicTitleOf(cell) {
  return stripMarkdown(normalise(cell));
}

/** The status token, or null when the cell is anything but one vocabulary word (a closing full stop allowed: "Done."). */
export function statusOf(cell) {
  const text = stripMarkdown(cell).toLowerCase().replace(/\.$/, '');
  return Object.prototype.hasOwnProperty.call(STATUS_WORDS, text) ? STATUS_WORDS[text] : null;
}

/** Y or N, or null for anything else. */
export function typeOf(cell) {
  const t = stripMarkdown(cell);
  return t === 'Y' || t === 'N' ? t : null;
}

/** A number, or null for an empty cell. Anything else is undefined (the build fails). */
function priorityOf(cell) {
  const n = stripMarkdown(cell);
  if (n === '') return null;
  return /^\d+$/.test(n) ? Number(n) : undefined;
}

/** Lower-case letters and digits only: "Name box", "name_box", "name-box" and "NameBox" are one term. */
export function canonicalTerm(s) {
  return normalise(s).toLowerCase().replace(/[^a-z0-9]/g, '');
}

/** The salted hash of one deny term, as committed in docs/roadmap-deny.json. */
export function hashTerm(salt, term) {
  return createHash('sha256').update(`${salt}:${canonicalTerm(term)}`).digest('hex');
}

/** Deny terms are at most this many words long; longer runs are not tried. */
const MAX_TERM_WORDS = 4;

/** The deny hashes, checked: a 32-hex salt and at least one sha256. Anything else fails closed. */
export function denyHashSet(denyHashes) {
  const ok = denyHashes && /^[0-9a-f]{32}$/.test(denyHashes.salt || '')
    && Array.isArray(denyHashes.hashes) && denyHashes.hashes.length > 0
    && denyHashes.hashes.every((h) => /^[0-9a-f]{64}$/.test(h));
  if (!ok) throw new Error('roadmap: no valid deny hashes (docs/roadmap-deny.json); the build fails closed');
  return { salt: denyHashes.salt, set: new Set(denyHashes.hashes) };
}

/** True when a run of one to four words of `text`, joined, hashes to a deny hash. */
export function namesHashedTerm(text, denyHashes) {
  const { salt, set } = denyHashSet(denyHashes);
  const words = normalise(text).toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
  for (let i = 0; i < words.length; i += 1) {
    let joined = '';
    for (let n = 0; n < MAX_TERM_WORDS && i + n < words.length; n += 1) {
      joined += words[i + n];
      if (set.has(createHash('sha256').update(`${salt}:${joined}`).digest('hex'))) return true;
    }
  }
  return false;
}

/** Cells of one table line. A `\|` is a pipe inside a cell, not a cell border. */
function splitRow(line) {
  const inner = line.trim().replace(/^\|/, '').replace(/\|$/, '');
  return inner.split(/(?<!\\)\|/).map((c) => c.replace(/\\\|/g, '|').trim());
}

/** The public table of docs/ROADMAP.md: header names and one object per row (raw cells; `cells` counts them). */
export function parseRoadmap(markdown) {
  const lines = String(markdown).replace(/\r\n/g, '\n').split('\n');
  const start = lines.findIndex((l) => /^\|\s*Priority\s*\|\s*ID\s*\|/.test(l));
  if (start < 0) throw new Error('roadmap: the public table header was not found');
  const header = splitRow(lines[start]);
  const rows = [];
  for (let i = start + 2; i < lines.length && lines[i].startsWith('|'); i += 1) {
    const cells = splitRow(lines[i]);
    const row = {};
    header.forEach((name, k) => { row[name] = cells[k] ?? ''; });
    Object.defineProperty(row, 'cells', { value: cells.length });
    rows.push(row);
  }
  return { header, rows };
}

function assertClearOfDeny(where, value, deny, denyHashes) {
  if (namesHashedTerm(value, denyHashes)) throw new Error(`public-safety: ${where} names a deny-list term`);
  const lower = value.toLowerCase();
  for (const term of deny) {
    if (term && lower.includes(normalise(term).toLowerCase())) throw new Error(`public-safety: ${where} names a deny-list term`);
  }
}

function assertSafe(where, value, deny, denyHashes) {
  for (const re of UNSAFE) {
    if (re.test(value)) throw new Error(`public-safety: ${where} would reach the page (${re})`);
  }
  assertClearOfDeny(where, value, deny, denyHashes);
}

/** The whole of docs/ROADMAP.md carries no host detail: no machine name, provider, laptop path, address or deny term. */
export function assertPublicDoc(markdown, { deny = [], denyHashes } = {}) {
  const text = normalise(markdown);
  for (const re of HOST_DETAIL) {
    const m = text.match(re);
    if (m) throw new Error(`public-safety: docs/ROADMAP.md carries host detail (${re})`);
  }
  assertClearOfDeny('docs/ROADMAP.md', text, deny, denyHashes);
}

/** Allow-listed, normalised, filtered and ordered rows. `deny` adds plain terms; `denyHashes` is required. */
export function publicRows({ header, rows }, { deny = [], denyHashes } = {}) {
  denyHashSet(denyHashes);
  if (header.length !== PUBLIC_TABLE.length || header.some((h, k) => h !== PUBLIC_TABLE[k])) {
    throw new Error(`roadmap: the public table carries exactly ${PUBLIC_TABLE.join(', ')}; found ${header.join(', ')}`);
  }
  const out = [];
  const refs = new Set();
  rows.forEach((row, index) => {
    const id = row.ID;
    if (!ROW_ID.test(id)) throw new Error(`roadmap: row ID ${JSON.stringify(id)} does not match ${ROW_ID}`);
    if (row.cells !== PUBLIC_TABLE.length) throw new Error(`roadmap: ${id} has ${row.cells} cells; the public table has ${PUBLIC_TABLE.length}`);
    if (!REF.test(row.Ref)) throw new Error(`roadmap: ${id} needs a ref of rf- and ten hex digits (every row carries one)`);
    if (refs.has(row.Ref)) throw new Error(`roadmap: ${id} repeats the ref ${row.Ref}`);
    refs.add(row.Ref);
    const title = publicTitleOf(row['Public title']);
    if (!title) throw new Error(`roadmap: ${id} has no public title`);
    assertSafe(`${id} Title`, title, deny, denyHashes);
    if (!/^[\x20-\x7e]+$/.test(title)) throw new Error(`roadmap: ${id} public title is not plain ASCII after normalisation`);
    const status = statusOf(row.Status);
    if (status == null) throw new Error(`roadmap: ${id} has a status outside the vocabulary: "${stripMarkdown(row.Status)}"`);
    const type = typeOf(row.Type);
    if (type == null) throw new Error(`roadmap: ${id} has a Type other than Y or N`);
    const priority = priorityOf(row.Priority);
    if (priority === undefined) throw new Error(`roadmap: ${id} has a Priority that is not a number`);
    if (DROPPED_STATUS.has(status)) return;
    out.push({ pub: { Priority: priority, Row: id, Title: title, Status: status, Type: type }, index });
  });
  out.sort((a, b) => {
    const pa = a.pub.Priority ?? Number.POSITIVE_INFINITY;
    const pb = b.pub.Priority ?? Number.POSITIVE_INFINITY;
    return pa - pb || a.index - b.index;
  });
  return out.map(({ pub }) => pub);
}

/** The "Page deny list" bullets of the maintainers' tracker. */
export function trackerDenyTerms(text) {
  const section = String(text).split(/^## Page deny list\s*$/m)[1] || '';
  return [...section.matchAll(/^- (.+?)\s*$/gm)].map((m) => m[1]);
}

/** The committed hashes must be exactly the tracker's terms: none missing, none extra. */
export function assertDenyHashesMatch(terms, denyHashes) {
  const { salt, set } = denyHashSet(denyHashes);
  const want = new Set(terms.map((t) => hashTerm(salt, t)));
  const missing = [...want].filter((h) => !set.has(h)).length;
  const extra = [...set].filter((h) => !want.has(h)).length;
  if (missing || extra) {
    throw new Error(`roadmap: docs/roadmap-deny.json is out of step with the tracker (${missing} missing, ${extra} extra): run --write-deny-hashes`);
  }
}

/** The first 12 hex digits of the source's sha256: survives a squash merge, unlike a commit id. */
export function sourceDigest(markdown) {
  return createHash('sha256').update(String(markdown).replace(/\r\n/g, '\n')).digest('hex').slice(0, 12);
}

function esc(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/** The page: the site's sub-path skeleton, one table, the source line, a static footer (no request leaves the page). */
export function renderRoadmapPage(rows, { source }) {
  if (!/^[0-9a-f]{12}$/.test(String(source))) throw new Error('roadmap: source must be 12 hex digits');
  const head = PUBLIC_COLUMNS.map((c) => `<th scope="col">${esc(c)}</th>`).join('');
  const body = rows.map((r) => `      <tr>${PUBLIC_COLUMNS.map((c) => `<td>${esc(r[c] ?? '—')}</td>`).join('')}</tr>`).join('\n');
  return `<!DOCTYPE html>
<html lang="en" data-theme="dark">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Shear roadmap</title>
  <meta name="description" content="The Shear roadmap: every open row, in priority order." />
  <link rel="icon" href="../brand/favicon.ico" sizes="any" />
  <link rel="icon" type="image/png" href="../brand/favicon-32.png" sizes="32x32" />
  <link rel="stylesheet" href="../css/site.css" />
  <link rel="stylesheet" href="../shared/shear-chrome.css" />
  <link rel="stylesheet" href="../css/saas-dark.css" />
  <style>
    .roadmap-wrap { max-width: 1100px; margin: 0 auto; padding: 24px 16px 48px; }
    .roadmap-scroll { overflow-x: hidden; overflow-y: auto; max-height: 70vh; border: 1px solid var(--hairline-strong); border-radius: 8px; }
    table.roadmap { table-layout: fixed; border-collapse: collapse; width: 100%; font-size: 0.95rem; }
    table.roadmap th, table.roadmap td { padding: 8px 12px; text-align: left; border-bottom: 1px solid var(--hairline); vertical-align: top; overflow-wrap: anywhere; }
    table.roadmap th { position: sticky; top: 0; background: var(--bg-elev); color: var(--text); }
    table.roadmap th:nth-child(1), table.roadmap td:nth-child(1) { width: 4.5em; white-space: nowrap; }
    table.roadmap th:nth-child(2), table.roadmap td:nth-child(2) { width: 4.5em; }
    table.roadmap th:nth-child(4), table.roadmap td:nth-child(4) { width: 7em; }
    table.roadmap th:nth-child(5), table.roadmap td:nth-child(5) { width: 3.5em; }
    .roadmap-foot { margin-top: 12px; color: var(--text-dim); font-size: 0.85rem; }
    .footer-maturity { margin: 0 0 8px; color: var(--text-dim); font-size: 0.85rem; line-height: 1.4; }
    .footer-line { color: var(--text-dim); font-size: 0.85rem; }
    @media (max-width: 390px) {
      table.roadmap { font-size: 0.8rem; }
      table.roadmap th, table.roadmap td { padding: 6px 5px; }
      table.roadmap th:nth-child(1), table.roadmap td:nth-child(1) { width: 2.6em; }
      table.roadmap th:nth-child(2), table.roadmap td:nth-child(2) { width: 3.2em; }
      table.roadmap th:nth-child(4), table.roadmap td:nth-child(4) { width: 4.6em; }
      table.roadmap th:nth-child(5), table.roadmap td:nth-child(5) { width: 2.2em; }
    }
  </style>
</head>
<body>
  <div id="shear-chrome-root" data-active="MAIN" data-brand-base="../brand/"></div>
  <script src="../shared/shear-chrome.js"></script>
  <main class="roadmap-wrap">
    <h1>Roadmap</h1>
    <p>Every open row, in priority order. Type Y means the row moves a consensus pin; N means it does not.</p>
    <div class="roadmap-scroll">
    <table class="roadmap">
      <thead><tr>${head}</tr></thead>
      <tbody>
${body}
      </tbody>
    </table>
    </div>
    <p class="roadmap-foot">generated from docs/ROADMAP.md (sha256 ${source})</p>
  </main>
  <footer class="footer">
    <div class="wrap footer-inner">
      <p class="footer-maturity">Experimental testnet software, coins have no value.</p>
      <div class="footer-line">Shear testnet</div>
      <nav>
        <a href="../index.html">Home</a>
        <a href="../network.html">Network</a>
        <a href="../docs/index.html">Docs</a>
        <a href="../privacy.html">Privacy</a>
        <a href="../legal.html">Legal &amp; licences</a>
      </nav>
    </div>
  </footer>
</body>
</html>
`;
}

/** The page for one docs/ROADMAP.md. `denyHashes` is required: without it the build fails closed. */
export function buildRoadmapPage(markdown, { deny = [], denyHashes } = {}) {
  assertPublicDoc(markdown, { deny, denyHashes });
  return renderRoadmapPage(publicRows(parseRoadmap(markdown), { deny, denyHashes }), { source: sourceDigest(markdown) });
}

/** The tracker on this machine, if any (the second name is the tracker's first-round name). */
function trackerPath(repoRoot) {
  for (const name of ['ROADMAP.tracker.md', 'ROADMAP.private.md']) {
    const p = path.join(repoRoot, 'docs', name);
    if (fs.existsSync(p)) return p;
  }
  return null;
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const repoRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
  const docPath = path.join(repoRoot, 'docs', 'ROADMAP.md');
  const outPath = path.join(repoRoot, 'site', 'roadmap', 'index.html');
  const hashPath = path.join(repoRoot, 'docs', 'roadmap-deny.json');
  const tracker = trackerPath(repoRoot);
  const deny = tracker ? trackerDenyTerms(fs.readFileSync(tracker, 'utf8')) : [];
  const readHashes = () => (fs.existsSync(hashPath) ? JSON.parse(fs.readFileSync(hashPath, 'utf8')) : null);
  if (process.argv.includes('--write-deny-hashes')) {
    if (!tracker || deny.length === 0) {
      process.stderr.write('--write-deny-hashes needs the tracker and its Page deny list on this machine\n');
      process.exit(1);
    }
    const old = readHashes();
    const salt = old && /^[0-9a-f]{32}$/.test(old.salt || '') ? old.salt : randomBytes(16).toString('hex');
    const hashes = [...new Set(deny.map((t) => hashTerm(salt, t)))].sort();
    fs.writeFileSync(hashPath, `${JSON.stringify({ salt, hashes }, null, 2)}\n`);
    process.stdout.write(`wrote docs/roadmap-deny.json: ${hashes.length} hashes\n`);
    process.exit(0);
  }
  const denyHashes = readHashes();
  denyHashSet(denyHashes);
  if (tracker) assertDenyHashesMatch(deny, denyHashes);
  const markdown = fs.readFileSync(docPath, 'utf8');
  const html = buildRoadmapPage(markdown, { deny, denyHashes });
  if (process.argv.includes('--check')) {
    const have = fs.existsSync(outPath) ? fs.readFileSync(outPath, 'utf8') : '';
    if (have !== html) {
      process.stderr.write('site/roadmap/index.html is stale: run node scripts/build_roadmap_page.mjs\n');
      process.exit(1);
    }
    process.stdout.write('site/roadmap/index.html is current\n');
  } else {
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    fs.writeFileSync(outPath, html);
    process.stdout.write(`wrote ${path.relative(repoRoot, outPath)} from docs/ROADMAP.md (sha256 ${sourceDigest(markdown)})\n`);
  }
}
