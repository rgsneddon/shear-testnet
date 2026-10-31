import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  PUBLIC_COLUMNS,
  buildRoadmapPage,
  parseRoadmap,
  publicRows,
} from '../../scripts/build_roadmap_page.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.join(here, '../..');
const COMMIT = '0123456789abcdef0123456789abcdef01234567';
const read = (p) => fs.readFileSync(path.join(repoRoot, p), 'utf8');

const HEADER = '| Priority | ID | Public title | Type | Status | Private ref |\n'
  + '|----------|----|--------------|------|--------|-------------|\n';

/** A doc with the public table, then a detail table the build must never read. */
function doc(rows, header = HEADER) {
  return `# Shear roadmap\n\n## Rows\n\nIntro text.\n\n${header}${rows.join('\n')}\n\n### Row detail\n\n`
    + '| ID | Item | Owner |\n|----|------|-------|\n| R09 | DETAIL-SENTINEL internal text | OWNER-SENTINEL |\n\n**Note.** After the table.\n';
}

/** A public row: [priority, id, public title, type, status, private ref]. */
function row(priority, id, title, type, status, ref = '') {
  return `| ${priority} | ${id} | ${title} | ${type} | ${status} | ${ref} |`;
}

const ROWS = [
  row(3, 'R29', 'Pool share hardening', 'Y', 'planned', 'pt-0a1b2c'),
  row(2, 'R01b', 'Vault claim post from the wallet', 'Y', 'planned'),
  row('', 'R01', 'Transaction digest update', 'Y', 'merged'),
  row(9, 'R28', 'BluNotes: private share payees and payouts', 'Y', 'coding'),
  row('', 'R09', 'Token spec', 'N', 'planned'),
  row(9, 'R33', 'Share batch hardening', 'Y', 'planned', 'pt-3d4e5f'),
  row(24, 'R19', 'Mainnet genesis', 'Y', 'Done.'),
  row(24, 'R16', 'v12 cut', 'N', 'closed'),
  row(24, 'R17', 'Stressnet', 'N', 'Shipped'),
  row(24, 'R18b', 'Mainnet release deploy', 'N', 'Deployed'),
  row(5, 'R40', 'Hash key derivation', 'Y', 'ruled', 'pt-6a7b8c'),
];

const build = (rows, opts = {}) => buildRoadmapPage(doc(rows), { commit: COMMIT, ...opts });
const planted = (title, opts) => build([row(1, 'R50', title, 'N', 'planned')], opts);

describe('roadmap page generator', () => {
  it('rows whose status is done, closed, merged, shipped or deployed drop off', () => {
    const rows = publicRows(parseRoadmap(doc(ROWS)));
    const ids = rows.map((r) => r.Row);
    assert.deepEqual(ids.sort(), ['R01b', 'R09', 'R28', 'R29', 'R33', 'R40'].sort());
    for (const gone of ['R01', 'R19', 'R16', 'R17', 'R18b']) assert.equal(ids.includes(gone), false, gone);
  });

  it('a status outside the vocabulary fails the build; an empty one too', () => {
    for (const status of ['', 'soon', 'blocked', 'planed']) {
      assert.throws(() => build([row(1, 'R50', 'Plain title', 'N', status)]), /status/, JSON.stringify(status));
    }
    const byId = Object.fromEntries(publicRows(parseRoadmap(doc(ROWS))).map((r) => [r.Row, r]));
    assert.equal(byId.R29.Status, 'planned');
    assert.equal(byId.R28.Status, 'active');
    assert.equal(byId.R40.Status, 'ruled');
  });

  it('the public table carries exactly ID, Priority, Public title, Type, Status and Private ref; more fails the build', () => {
    assert.deepEqual(PUBLIC_COLUMNS, ['Priority', 'Row', 'Title', 'Status', 'Type']);
    const html = build(ROWS);
    for (const sentinel of ['DETAIL-SENTINEL', 'OWNER-SENTINEL', 'pt-0a1b2c', 'Private ref']) {
      assert.equal(html.includes(sentinel), false, sentinel);
    }
    const heads = [...html.matchAll(/<th[^>]*>([^<]*)<\/th>/g)].map((m) => m[1]);
    assert.deepEqual(heads, PUBLIC_COLUMNS);
    for (const extra of ['Item', 'Owner', 'Host']) {
      const wide = HEADER.replace('| Private ref |', `| Private ref | ${extra} |`).replace('|-------------|\n', '|-------------|------|\n');
      const rows = [`${row(1, 'R50', 'Plain title', 'N', 'planned')} internal ${extra.toLowerCase()} text |`];
      assert.throws(() => buildRoadmapPage(doc(rows, wide), { commit: COMMIT }), /public table/, extra);
    }
    const extraCell = `${row(1, 'R50', 'Plain title', 'N', 'planned')} smuggled detail |`;
    assert.throws(() => build([extraCell]), /R50.*cells/);
    const noRef = HEADER.replace(' Private ref |', '').replace('-------------|', '');
    assert.throws(() => buildRoadmapPage(doc(['| 1 | R50 | Plain title | N | planned |'], noRef), { commit: COMMIT }), /public table/);
  });

  it('the private ref is opaque: anything but pt- and six hex digits fails the build', () => {
    for (const ref of ['H5 pool share', 'see R29', 'pt-zzzzzz', 'pt-0a1b2c3']) {
      assert.throws(() => build([row(1, 'R50', 'Plain title', 'N', 'planned', ref)]), /private ref/, ref);
    }
    assert.match(build([row(1, 'R50', 'Plain title', 'N', 'planned', 'pt-abc123')]), /R50/);
  });

  it('every row needs a public title, a dropped row too', () => {
    const byId = Object.fromEntries(publicRows(parseRoadmap(doc(ROWS))).map((r) => [r.Row, r]));
    assert.equal(byId.R29.Title, 'Pool share hardening');
    assert.equal(byId.R01b.Title, 'Vault claim post from the wallet');
    assert.equal(byId.R29.Type, 'Y');
    assert.equal(byId.R09.Type, 'N');
    assert.throws(() => build([row(1, 'R50', '', 'N', 'planned')]), /R50.*public title/);
    assert.throws(() => build([row(1, 'R51', '', 'N', 'done')]), /R51.*public title/);
  });

  it('a row ID must match ^R\\d{2}[a-z]?$', () => {
    for (const id of ['R1', 'R001', 'R01B', 'X01', 'R01-a', 'r01', 'R01ab', 'R０1', 'R01​', 'R 01']) {
      assert.throws(() => build([row(1, id, 'Plain title', 'N', 'planned')]), /ID/, JSON.stringify(id));
    }
    const ids = publicRows(parseRoadmap(doc(['R01', 'R01b', 'R40', 'R99z'].map((id) => row(1, id, 'Plain title', 'N', 'planned'))))).map((r) => r.Row);
    assert.deepEqual(ids, ['R01', 'R01b', 'R40', 'R99z']);
  });

  it('titles are NFKC-normalised with zero-width characters stripped, and must then be plain ASCII', () => {
    assert.match(planted('Ｐｏｏｌ hardening'), /<td>Pool hardening<\/td>/);
    assert.match(planted('Pool​ share⁠ hard﻿ening'), /<td>Pool share hardening<\/td>/);
    for (const title of ['Café scan', 'Pool — hardening', 'Wallet \u{1F512} scan', 'Pool share hardening ']) {
      assert.throws(() => planted(title), /plain ASCII/, JSON.stringify(title));
    }
    assert.throws(() => planted('ＣＶＥ-2024-12345 fix'), /public-safety/, 'fullwidth CVE');
    assert.throws(() => planted('Pool expl​oit fix'), /public-safety/, 'zero-width split');
    assert.throws(() => planted('Ｈ５ fix'), /public-safety/, 'fullwidth finding code');
  });

  it('neutral titles pass the deny-list', () => {
    for (const title of ['v12 cut', 'Android ABIs beyond arm64-v8a', 'P2P relay', 'Dev-network pin move', 'Wallet light mode scan', 'ShearK-Miner optimisation', 'Reserve epoch, withdraw and claim follow-ups']) {
      assert.match(planted(title), /R50/, title);
    }
  });

  const DENIED = {
    'finding code H5': 'Pool fix for H5',
    'finding code F-2': 'F-2 follow-up',
    'finding code K-1a': 'K-1a closure',
    'finding code N4': 'Relay N4 fix',
    'priority label P0-P3': 'p1 wallet fix',
    'severity word critical': 'Critical vault fix',
    'severity word high': 'High pool fix',
    'severity word medium': 'MEDIUM share fix',
    'severity word low': 'low ledger fix',
    'exploit word': 'Exploitable share path',
    'vuln word': 'Vault vulnerability fix',
    'leak word': 'Wallet privacy leak',
    'bypass word': 'Fee bypass closed',
    'grief word': 'Pool griefing guard',
    'CVE id': 'Patch for cve-2024-12345',
    'lane name': 'Pool Share LANE review',
    'lane role': 'Privacy auditor follow-up',
    hostname: 'Move to admin.example.org',
    ip: 'Node health at 203.0.113.7 wobbles',
    'pr label': 'Tests from pr 2',
    'pr label with suffix': 'Fixtures from PR 3a',
    'goal label': 'goal 10 F hardening',
    email: 'Ask ops@example.org',
    'file path': 'Check crypto/hash_owed.js:381',
    'file path without line': 'Fix node/src/chain.js',
    'owner name': 'russell to rule',
    'agent name': 'cos routes this',
    pid: 'Watch PID 4242',
  };
  for (const [name, title] of Object.entries(DENIED)) {
    it(`the deny-list refuses a ${name}, in any case`, () => {
      assert.throws(() => planted(title), /public-safety/, title);
    });
  }

  it('host and lane names from the private deny list are refused, in any case, and only when listed', () => {
    const deny = ['build-host-zz', 'Example Lane Name'];
    assert.throws(() => planted('Rebuild BUILD-HOST-ZZ first', { deny }), /public-safety/);
    assert.throws(() => planted('example lane name sign-off', { deny }), /public-safety/);
    assert.throws(() => planted('Rebuild build​-host-zz first', { deny }), /public-safety/);
    assert.match(planted('Rebuild the build host first', { deny }), /R50/);
  });

  it('an escaped pipe stays inside its cell', () => {
    const { header, rows } = parseRoadmap(doc([row(1, 'R52', 'A title with a \\| bar', 'N', 'planned')]));
    assert.equal(header.length, 6);
    assert.equal(rows.length, 1);
    assert.equal(rows[0]['Public title'], 'A title with a | bar');
    assert.equal(rows[0].Status, 'planned');
    assert.match(build([row(1, 'R52', 'Title with a \\| bar', 'N', 'planned')]), /Title with a \| bar/);
  });

  it('rows come out in Priority order; unranked rows last, in their written order', () => {
    const ids = publicRows(parseRoadmap(doc(ROWS))).map((r) => r.Row);
    assert.deepEqual(ids, ['R01b', 'R29', 'R40', 'R28', 'R33', 'R09']);
  });

  it('is deterministic: same input, same bytes, and names its source commit', () => {
    const a = build(ROWS);
    assert.equal(a, build(ROWS));
    assert.match(a, new RegExp(`generated from docs/ROADMAP\\.md at ${COMMIT.slice(0, 12)}`));
    assert.notEqual(a, build(ROWS, { commit: 'f'.repeat(40) }));
  });

  it('uses the site chrome and CSS, makes no external request, and adds no navbar link', () => {
    const html = build(ROWS);
    assert.match(html, /data-theme="dark"/);
    assert.match(html, /href="\.\.\/css\/site\.css"/);
    assert.match(html, /href="\.\.\/shared\/shear-chrome\.css"/);
    assert.match(html, /href="\.\.\/css\/saas-dark\.css"/);
    assert.match(html, /id="shear-chrome-root" data-active="MAIN" data-brand-base="\.\.\/brand\/"/);
    assert.match(html, /src="\.\.\/shared\/shear-chrome\.js"/);
    for (const m of html.matchAll(/(?:src|href)="([^"]+)"/g)) {
      assert.doesNotMatch(m[1], /^(https?:)?\/\//, m[1]);
    }
    assert.doesNotMatch(html, /@import|fonts\.googleapis|<iframe|analytics|gtag|fetch\(|XMLHttpRequest/);
    assert.doesNotMatch(html, /nav-btn/);
    assert.match(html, /<table[^>]*class="roadmap"/);
  });

  it('reads in both themes: tokens, not a hard-coded header colour; the Type column does not scroll at 390px', () => {
    const html = build(ROWS);
    const style = html.match(/<style>([\s\S]*?)<\/style>/)?.[1] || '';
    assert.ok(style.length > 0);
    assert.doesNotMatch(style, /#[0-9a-f]{3,8}\b/i, 'no literal colours in the page style');
    assert.match(style, /table\.roadmap th \{[^}]*background: var\(--/);
    assert.match(style, /border[^;]*var\(--hairline/);
    assert.match(style, /table\.roadmap \{[^}]*table-layout: fixed/);
    assert.match(style, /overflow-wrap: anywhere/);
    assert.doesNotMatch(style, /nth-child\(5\)[^{]*\{[^}]*nowrap/);
    assert.match(style, /@media \(max-width: 390px\)/);
    assert.match(style, /\.roadmap-scroll \{[^}]*overflow-x: hidden/);
  });

  it('carries the standard five-link footer and the maturity line', () => {
    const html = build(ROWS);
    const footer = html.match(/<footer class="footer">([\s\S]*?)<\/footer>/)?.[1] || '';
    assert.ok(footer.length > 0, 'a footer');
    const links = [...footer.matchAll(/<a href="([^"]+)">([^<]+)<\/a>/g)].map((m) => [m[1], m[2]]);
    assert.deepEqual(links, [
      ['../index.html', 'Home'],
      ['../network.html', 'Network'],
      ['../docs/index.html', 'Docs'],
      ['../privacy.html', 'Privacy'],
      ['../legal.html', 'Legal &amp; licences'],
    ]);
    assert.ok(footer.includes('Experimental testnet software, coins have no value'), 'the maturity line, exactly');
    assert.match(footer, /<p class="footer-maturity">Experimental testnet software, coins have no value\.<\/p>/);
    assert.match(footer, /<div data-shear-foot data-wallet-fallback="0\.71" data-network-fallback="shear-testnet-v11">Shear · … · Continuum … · …<\/div>/);
    assert.match(html, /<script src="\.\.\/shared\/site-identity\.js"><\/script>/);
    assert.ok(html.indexOf('generated from docs/ROADMAP.md') < html.indexOf('<footer'), 'the source line sits above the footer');
  });
});

/** Terms the page must never show: the deny classes, checked again on the committed page. */
const PAGE_DENIED = [
  /\b(?!v)[a-z](?:-\d{1,2}[a-z]?|\d{1,2})\b/i,
  /\bP[0-3]\b/i,
  /\b(?:critical|high|medium|low|severe|severity)\b/i,
  /\b(?:exploit|vuln|leak|bypass|grief)/i,
  /\bCVE-\d{4}-\d{4,}\b/i,
  /\b(?:lanes?|auditor|assailant)\b/i,
  /\b\d{1,3}(?:\.\d{1,3}){3}\b/,
  /\bPRs?\s*#?\d|\bGoals?\s*\d/i,
  /@|\.(?:js|mjs|dart|rs|md)\b/i,
];

/** The private tracker's deny terms, when the private tracker is on this machine. */
function privateTerms() {
  const p = path.join(repoRoot, 'docs', 'ROADMAP.private.md');
  if (!fs.existsSync(p)) return [];
  const text = fs.readFileSync(p, 'utf8').split(/^## Page deny list\s*$/m)[1] || '';
  return [...text.matchAll(/^- (.+?)\s*$/gm)].map((m) => m[1]);
}

describe('the committed roadmap page and its links', () => {
  it('--check passes: the committed page is the build of docs/ROADMAP.md at its last commit', () => {
    const run = spawnSync(process.execPath, [path.join(repoRoot, 'scripts', 'build_roadmap_page.mjs'), '--check'], {
      cwd: repoRoot,
      encoding: 'utf8',
      timeout: 60_000,
    });
    assert.equal(run.status, 0, run.stderr || run.stdout);
    assert.match(run.stdout, /is current/);
  });

  it('the footer sha is the last commit that touched docs/ROADMAP.md, not whatever the page says', () => {
    const page = read('site/roadmap/index.html');
    const stamped = page.match(/generated from docs\/ROADMAP\.md at ([0-9a-f]{12})/)?.[1];
    assert.ok(stamped, 'the page names its source commit');
    const last = execFileSync('git', ['log', '-1', '--format=%H', '--', 'docs/ROADMAP.md'], { cwd: repoRoot, encoding: 'utf8' }).trim();
    assert.match(last, /^[0-9a-f]{40}$/);
    assert.equal(stamped, last.slice(0, 12));
    assert.equal(page, buildRoadmapPage(read('docs/ROADMAP.md'), { commit: last }));
  });

  it('the rebuilt page shows no denied term: every cell is plain ASCII and clear of each deny class', () => {
    const page = read('site/roadmap/index.html');
    const cells = [...page.matchAll(/<td>([^<]*)<\/td>/g)].map((m) => m[1]);
    assert.ok(cells.length >= 5 * 10, 'the page has rows');
    const titles = cells.filter((_, k) => k % 5 === 2);
    for (const title of titles) {
      assert.match(title, /^[\x20-\x7e]+$/, title);
      for (const re of PAGE_DENIED) assert.doesNotMatch(title, re, `${title} vs ${re}`);
      for (const term of privateTerms()) assert.equal(title.toLowerCase().includes(term.toLowerCase()), false, title);
    }
    for (const id of cells.filter((_, k) => k % 5 === 1)) assert.match(id, /^R\d{2}[a-z]?$/, id);
    assert.ok(page.includes('<td>Wallet light mode scan</td>'), 'R01c carries its new title');
  });

  it('docs/ROADMAP.md: a six-column public table, no security detail, and the private tracker is never committed', () => {
    const md = read('docs/ROADMAP.md');
    const { header, rows } = parseRoadmap(md);
    assert.deepEqual(header, ['Priority', 'ID', 'Public title', 'Type', 'Status', 'Private ref']);
    const r01c = rows.find((r) => r.ID === 'R01c');
    assert.equal(r01c['Public title'], 'Wallet light mode scan');
    const secret = rows.filter((r) => r['Private ref']);
    assert.ok(secret.length >= 10, 'the open security rows carry a private ref');
    const lines = md.split(/\r?\n/);
    for (const r of secret) {
      const named = lines.filter((l) => new RegExp(`^\\|\\s*${r.ID}\\s*\\|`).test(l));
      assert.deepEqual(named, [], `${r.ID} has no detail line in the public file`);
    }
    assert.doesNotMatch(md, /\bH\d{1,2}\b/, 'no finding code of the share research');
    assert.doesNotMatch(md, /\*\*(?:high|medium|low)\b/i, 'no severity mark');
    const ignored = read('.gitignore');
    assert.match(ignored, /^docs\/ROADMAP\.private\.md\r?$/m);
    const tracked = execFileSync('git', ['ls-files', '--', 'docs/ROADMAP.private.md'], { cwd: repoRoot, encoding: 'utf8' }).trim();
    assert.equal(tracked, '', 'the private tracker is not tracked');
  });

  it('the Docs page links to the roadmap; the navbar and the template lock do not change', () => {
    const content = read('site/docs/content.js');
    assert.match(content, /href="https:\/\/shear\.digital\/roadmap\/"/);
    const chrome = read('site/shared/shear-chrome.js');
    assert.doesNotMatch(chrome, /roadmap/i);
    const lock = read('site/template-lock.json');
    assert.doesNotMatch(lock, /roadmap/i);
    const docsPage = read('site/docs/index.html');
    assert.doesNotMatch(docsPage, /roadmap/i, 'the link lives in the docs content, not the locked skeleton');
  });

  it('CLAUDE.md names no test host and no handoff path; the hosts live in the local file', () => {
    const claude = read('CLAUDE.md');
    assert.doesNotMatch(claude, /DONE\.jsonl|\/root\/|\b\d{1,3}(?:\.\d{1,3}){3}\b/);
    for (const term of privateTerms()) assert.equal(claude.toLowerCase().includes(term.toLowerCase()), false, 'a private term');
    assert.match(claude, /Test hosts and their limits are listed in CLAUDE\.local\.md\./);
    const ignored = read('.gitignore');
    assert.match(ignored, /^CLAUDE\.local\.md\r?$/m);
    const tracked = execFileSync('git', ['ls-files', '--', 'CLAUDE.local.md'], { cwd: repoRoot, encoding: 'utf8' }).trim();
    assert.equal(tracked, '', 'CLAUDE.local.md is not tracked');
  });

  it('.gitignore keeps operator admin vhosts out by a generic pattern, never by name', () => {
    const lines = read('.gitignore').split(/\r?\n/);
    assert.ok(lines.includes('deploy/nginx-*-admin.conf'), 'the generic admin pattern');
    for (const l of lines.filter((x) => x.startsWith('deploy/nginx-'))) {
      assert.ok(l.includes('*'), `a named vhost in .gitignore: line ${lines.indexOf(l) + 1}`);
    }
  });
});
