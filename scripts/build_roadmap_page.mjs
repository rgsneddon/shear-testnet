#!/usr/bin/env node
/**
 * Build the public roadmap page (site/roadmap/index.html) from docs/ROADMAP.md.
 *
 * Public-safe by construction: an allow-list of output columns, each cell a
 * plain token or the row's Public title, and a refusal (no output at all) if
 * anything that reaches the page looks like a host, an IP, an owner note, a
 * lane, a PR or Goal label, an email or a file path. A listed row with no
 * Public title fails the build, and so does a status outside the vocabulary.
 * Rows whose status is done, closed, merged, shipped or deployed drop off.
 * Same input, same bytes.
 *
 *   node scripts/build_roadmap_page.mjs          # write the page
 *   node scripts/build_roadmap_page.mjs --check  # exit 1 if the page is stale
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** The only columns the page may carry, in order. Everything else never leaves the doc. */
export const PUBLIC_COLUMNS = Object.freeze(['Priority', 'Row', 'Title', 'Status', 'Type']);

/** Doc column -> page column. A doc column not named here is dropped. */
const SOURCE_OF = Object.freeze({
  Priority: 'Priority',
  Row: 'ID',
  Title: 'Public title',
  Status: 'Status',
  Type: 'Consensus?',
});

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

/** Anything matching these must never reach the page: the build refuses. Every pattern is case-insensitive. */
const UNSAFE = [
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
  /\b(?:agent-box|p2p-[a-z]|p2pnode\d*|shear-pool|dedicated-de|ubuntu-soak|fedora-soak|windows-contabo)\b/i, // host names
  /\blanes?\b/i, // lane names
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

/** The Public title cell, as written. Empty is not a title. */
export function publicTitleOf(cell) {
  return stripMarkdown(cell);
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

export function typeOf(cell) {
  return /^y\b/i.test(stripMarkdown(cell)) ? 'Y' : 'N';
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

/** The Rows table of docs/ROADMAP.md: header names and one object per row (every doc column, raw). */
export function parseRoadmap(markdown) {
  const lines = String(markdown).replace(/\r\n/g, '\n').split('\n');
  const start = lines.findIndex((l) => /^\|\s*(Priority\s*\|\s*)?ID\s*\|\s*Item\s*\|/.test(l));
  if (start < 0) throw new Error('roadmap: the Rows table header was not found');
  const header = splitRow(lines[start]);
  const rows = [];
  for (let i = start + 2; i < lines.length && lines[i].startsWith('|'); i += 1) {
    const cells = splitRow(lines[i]);
    const row = {};
    header.forEach((name, k) => { row[name] = cells[k] ?? ''; });
    rows.push(row);
  }
  return { header, rows };
}

function assertSafe(where, value) {
  for (const re of UNSAFE) {
    if (re.test(value)) throw new Error(`public-safety: ${where} would reach the page (${re})`);
  }
}

/** Allow-listed, normalised, filtered and ordered rows. */
export function publicRows({ header, rows }) {
  for (const col of Object.values(SOURCE_OF)) {
    if (!header.includes(col)) throw new Error(`roadmap: the table has no "${col}" column`);
  }
  const out = [];
  rows.forEach((row, index) => {
    const id = stripMarkdown(row[SOURCE_OF.Row]);
    const status = statusOf(row[SOURCE_OF.Status]);
    if (status == null) throw new Error(`roadmap: ${id} has a status outside the vocabulary: "${stripMarkdown(row[SOURCE_OF.Status])}"`);
    if (DROPPED_STATUS.has(status)) return;
    const title = publicTitleOf(row[SOURCE_OF.Title]);
    if (!title) throw new Error(`roadmap: ${id} is listed but has no public title`);
    const pub = {
      Priority: priorityOf(row[SOURCE_OF.Priority]),
      Row: id,
      Title: title,
      Status: status,
      Type: typeOf(row[SOURCE_OF.Type]),
    };
    for (const col of PUBLIC_COLUMNS) assertSafe(`${pub.Row} ${col}`, String(pub[col] ?? ''));
    out.push({ pub, index });
  });
  out.sort((a, b) => {
    const pa = a.pub.Priority ?? Number.POSITIVE_INFINITY;
    const pb = b.pub.Priority ?? Number.POSITIVE_INFINITY;
    return pa - pb || a.index - b.index;
  });
  return out.map(({ pub }) => pub);
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

export function buildRoadmapPage(markdown, { commit }) {
  return renderRoadmapPage(publicRows(parseRoadmap(markdown)), { commit });
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const repoRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
  const docPath = path.join(repoRoot, 'docs', 'ROADMAP.md');
  const outPath = path.join(repoRoot, 'site', 'roadmap', 'index.html');
  const commit = execFileSync('git', ['log', '-1', '--format=%H', '--', 'docs/ROADMAP.md'], { cwd: repoRoot, encoding: 'utf8' }).trim();
  const html = buildRoadmapPage(fs.readFileSync(docPath, 'utf8'), { commit });
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
