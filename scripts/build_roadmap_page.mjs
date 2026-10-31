#!/usr/bin/env node
/**
 * Build the public roadmap page (site/roadmap/index.html) from docs/ROADMAP.md.
 *
 * Public-safe by construction. The build reads only the public table of
 * docs/ROADMAP.md, which carries exactly six columns (Priority, ID, Public
 * title, Type, Status, Private ref); any other column, or a row with more
 * cells, fails the build. Open security rows keep their detail in the
 * private tracker (docs/ROADMAP.private.md, gitignored, never committed).
 * Every row needs a Public title: NFKC-normalised, zero-width and fullwidth
 * forms stripped, then plain ASCII and clear of the deny-list, or the build
 * fails. An ID is R, two digits and an optional lower-case letter. A status
 * outside the vocabulary fails the build; done, closed, merged, shipped and
 * deployed rows drop off. Same input, same bytes.
 *
 *   node scripts/build_roadmap_page.mjs          # write the page
 *   node scripts/build_roadmap_page.mjs --check  # exit 1 if the page is stale
 *
 * When the private tracker is present, its "Page deny list" (host and lane
 * names, which no committed file may carry) is refused too.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** The only columns the page may carry, in order. */
export const PUBLIC_COLUMNS = Object.freeze(['Priority', 'Row', 'Title', 'Status', 'Type']);

/** The public table of docs/ROADMAP.md: exactly these columns, in this order. */
const PUBLIC_TABLE = Object.freeze(['Priority', 'ID', 'Public title', 'Type', 'Status', 'Private ref']);

/** The status vocabulary. The lead word of the cell, after markdown, picks the token; anything else fails the build. */
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
const PRIVATE_REF = /^(?:pt-[0-9a-f]{6})?$/;

/**
 * Anything matching these must never reach the page: the build refuses. Every
 * pattern is case-insensitive and runs on the normalised title. Host and lane
 * names are not written here (no committed file names a host); they come from
 * the private tracker's deny list.
 */
const UNSAFE = [
  /\b(?!v)[a-z](?:-\d{1,2}[a-z]?|\d{1,2})\b/i, // finding codes: H5, F-2, K-1a, N4 (v12 is a version)
  /\bP[0-3]\b/i, // priority labels P0-P3
  /\b(?:critical|high|medium|low|severe|severity)\b/i, // severity words
  /\b(?:exploit|vuln|leak|bypass|grief)/i, // exploit words
  /\bCVE-\d{4}-\d{4,}\b/i, // CVE ids
  /\b(?:lanes?|auditor|assailant|evaluator)\b/i, // lane names
  /\b(?:[a-z0-9-]+\.)+(?:digital|com|net|org|io|dev|app|xyz|de|uk)\b/i, // host names
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

/** The status token, or null when the cell is outside the vocabulary. */
export function statusOf(cell) {
  const text = stripMarkdown(cell).toLowerCase().replace(/^[*_\s]+/, '');
  for (const [word, token] of Object.entries(STATUS_WORDS)) {
    if (text === word || text.startsWith(`${word} `) || text.startsWith(`${word}(`) || text.startsWith(`${word},`)
      || text.startsWith(`${word}.`) || text.startsWith(`${word}:`) || text.startsWith(`${word};`)) return token;
  }
  return null;
}

/** Y or N, or null for anything else. */
export function typeOf(cell) {
  const t = stripMarkdown(cell);
  return t === 'Y' || t === 'N' ? t : null;
}

function priorityOf(cell) {
  const n = stripMarkdown(cell);
  return /^\d+$/.test(n) ? Number(n) : null;
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

function assertSafe(where, value, deny) {
  for (const re of UNSAFE) {
    if (re.test(value)) throw new Error(`public-safety: ${where} would reach the page (${re})`);
  }
  const lower = value.toLowerCase();
  for (const term of deny) {
    if (term && lower.includes(normalise(term).toLowerCase())) throw new Error(`public-safety: ${where} names a private deny-list term`);
  }
}

/** Allow-listed, normalised, filtered and ordered rows. `deny` adds private terms to refuse. */
export function publicRows({ header, rows }, { deny = [] } = {}) {
  if (header.length !== PUBLIC_TABLE.length || header.some((h, k) => h !== PUBLIC_TABLE[k])) {
    throw new Error(`roadmap: the public table carries exactly ${PUBLIC_TABLE.join(', ')}; found ${header.join(', ')}`);
  }
  const out = [];
  rows.forEach((row, index) => {
    const id = row.ID;
    if (!ROW_ID.test(id)) throw new Error(`roadmap: row ID ${JSON.stringify(id)} does not match ${ROW_ID}`);
    if (row.cells !== PUBLIC_TABLE.length) throw new Error(`roadmap: ${id} has ${row.cells} cells; the public table has ${PUBLIC_TABLE.length}`);
    if (!PRIVATE_REF.test(row['Private ref'])) throw new Error(`roadmap: ${id} has a private ref that is not opaque (pt- and six hex digits)`);
    const title = publicTitleOf(row['Public title']);
    if (!title) throw new Error(`roadmap: ${id} has no public title`);
    assertSafe(`${id} Title`, title, deny);
    if (!/^[\x20-\x7e]+$/.test(title)) throw new Error(`roadmap: ${id} public title is not plain ASCII after normalisation`);
    const status = statusOf(row.Status);
    if (status == null) throw new Error(`roadmap: ${id} has a status outside the vocabulary: "${stripMarkdown(row.Status)}"`);
    const type = typeOf(row.Type);
    if (type == null) throw new Error(`roadmap: ${id} has a Type other than Y or N`);
    if (DROPPED_STATUS.has(status)) return;
    out.push({ pub: { Priority: priorityOf(row.Priority), Row: id, Title: title, Status: status, Type: type }, index });
  });
  out.sort((a, b) => {
    const pa = a.pub.Priority ?? Number.POSITIVE_INFINITY;
    const pb = b.pub.Priority ?? Number.POSITIVE_INFINITY;
    return pa - pb || a.index - b.index;
  });
  return out.map(({ pub }) => pub);
}

/** The "Page deny list" bullets of the private tracker. */
export function privateDenyTerms(text) {
  const section = String(text).split(/^## Page deny list\s*$/m)[1] || '';
  return [...section.matchAll(/^- (.+?)\s*$/gm)].map((m) => m[1]);
}

function esc(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/** The page: the site's sub-path skeleton, one table, the source line, the standard footer. */
export function renderRoadmapPage(rows, { commit }) {
  const short = String(commit).slice(0, 12);
  if (!/^[0-9a-f]{12}$/.test(short)) throw new Error('roadmap: commit must be a hex sha');
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
    <p class="roadmap-foot">generated from docs/ROADMAP.md at ${short}</p>
  </main>
  <footer class="footer">
    <div class="wrap footer-inner">
      <p class="footer-maturity">Experimental testnet software, coins have no value.</p>
      <div data-shear-foot data-wallet-fallback="0.71" data-network-fallback="shear-testnet-v11">Shear · … · Continuum … · …</div>
      <nav>
        <a href="../index.html">Home</a>
        <a href="../network.html">Network</a>
        <a href="../docs/index.html">Docs</a>
        <a href="../privacy.html">Privacy</a>
        <a href="../legal.html">Legal &amp; licences</a>
      </nav>
    </div>
  </footer>
  <script src="../shared/site-identity.js"></script>
</body>
</html>
`;
}

export function buildRoadmapPage(markdown, { commit, deny = [] }) {
  return renderRoadmapPage(publicRows(parseRoadmap(markdown), { deny }), { commit });
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const repoRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
  const docPath = path.join(repoRoot, 'docs', 'ROADMAP.md');
  const outPath = path.join(repoRoot, 'site', 'roadmap', 'index.html');
  const commit = execFileSync('git', ['log', '-1', '--format=%H', '--', 'docs/ROADMAP.md'], { cwd: repoRoot, encoding: 'utf8' }).trim();
  const privPath = path.join(repoRoot, 'docs', 'ROADMAP.private.md');
  const deny = fs.existsSync(privPath) ? privateDenyTerms(fs.readFileSync(privPath, 'utf8')) : [];
  const html = buildRoadmapPage(fs.readFileSync(docPath, 'utf8'), { commit, deny });
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
    process.stdout.write(`wrote ${path.relative(repoRoot, outPath)} from docs/ROADMAP.md at ${commit.slice(0, 12)}\n`);
  }
}
