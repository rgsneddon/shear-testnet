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

const HEADER = '| Priority | ID | Item | Public title | Consensus? | Status | Owner | Reviewer | Working now | PR | Head SHA | Target |\n'
  + '|----------|----|------|--------------|------------|--------|-------|----------|-------------|----|----------|--------|\n';

function doc(rows) {
  return `# Shear roadmap\n\n## Rows\n\nIntro text.\n\n${HEADER}${rows.join('\n')}\n\n**Note.** After the table.\n`;
}

/** A row: [priority, id, item, public title, consensus, status]. The internal columns carry sentinels. */
function row(priority, id, item, title, consensus, status) {
  return `| ${priority} | ${id} | ${item} | ${title} | ${consensus} | ${status} | Claude OWNER-SENTINEL | Grok + Pool Share LANE-SENTINEL | claude, claude/x, since 10:00 | [#999](https://github.com/x/y/pull/999) PR-SENTINEL | deadbeef SHA-SENTINEL | 2 Nov TARGET-SENTINEL |`;
}

const ROWS = [
  row(3, 'R29', 'Hash-note admitPub not bound to the miner (share research H4, **high**; OWNER-NOTE Russell 27 Oct)', 'Pool share hardening', 'Y: a pin move', 'planned (filed, not fixed; Russell 27 Oct)'),
  row(2, 'R01b', 'Vault claim post: pool `queuedRewardClaim` takes the FS-1 claim body the wallet sends. **Russell 27 Oct:** more notes', 'Vault claim post from the wallet', 'Y: the block-decode revive', 'planned'),
  row('', 'R01', 'PR 130: digestTx and bundled fixes', '', 'Y: pins', 'merged'),
  row(9, 'R28', 'BluNotes: private share payees and payouts, plus pruning (R28; design on Desktop)', 'BluNotes: private share payees and payouts', 'Y: one pin move', 'coding (rule 16; Russell GO 27 Oct; draft PR on claude/r28-blunotes)'),
  row('', 'R09', 'Token spec (mint.shear.digital), spec only: the first half', 'Token spec', 'N: spec', 'planned (post-mainnet)'),
  row(9, 'R33', 'Share frame `lz` and frame order not canonical in shareSlotRoot (H10, **low**)', 'Share batch hardening', 'Y', 'planned (filed, not fixed; Russell 27 Oct)'),
  row(24, 'R19', 'Mainnet genesis', 'Mainnet genesis', 'Y: genesis', 'Done.'),
  row(24, 'R16', 'v12 cut (onto the rebuilt hosts), run from the R16 cut checklist', '', 'N', 'closed'),
  row(24, 'R17', 'Stressnet (7-day floor)', 'Stressnet', 'N', 'Shipped'),
  row(24, 'R18b', 'Final wipe and mainnet release deploy', 'Mainnet release deploy', 'N', 'Deployed 29 Oct'),
  row(5, 'R40', 'The miner and node "SHA-512" is not standard SHA-512', 'Hash key derivation', 'Y if fixed', '**Ruled 28 Oct (ruling 1):** fix it inside R28'),
];

describe('roadmap page generator', () => {
  it('rows whose status is done, closed, merged, shipped or deployed drop off', () => {
    const rows = publicRows(parseRoadmap(doc(ROWS)));
    const ids = rows.map((r) => r.Row);
    assert.deepEqual(ids.sort(), ['R01b', 'R09', 'R28', 'R29', 'R33', 'R40'].sort());
    for (const gone of ['R01', 'R19', 'R16', 'R17', 'R18b']) assert.equal(ids.includes(gone), false, gone);
  });

  it('a status outside the vocabulary fails the build; an empty one too', () => {
    for (const status of ['', 'soon', 'blocked on Russell', 'planed']) {
      const planted = doc([row(1, 'R50', 'Plain item', 'Plain title', 'N', status)]);
      assert.throws(() => buildRoadmapPage(planted, { commit: COMMIT }), /status/, JSON.stringify(status));
    }
    const byId = Object.fromEntries(publicRows(parseRoadmap(doc(ROWS))).map((r) => [r.Row, r]));
    assert.equal(byId.R29.Status, 'planned');
    assert.equal(byId.R28.Status, 'active');
    assert.equal(byId.R09.Status, 'planned');
    assert.equal(byId.R40.Status, 'ruled');
  });

  it('only the allow-listed columns reach the page, by name, and the Item text never does', () => {
    assert.deepEqual(PUBLIC_COLUMNS, ['Priority', 'Row', 'Title', 'Status', 'Type']);
    const html = buildRoadmapPage(doc(ROWS), { commit: COMMIT });
    for (const sentinel of ['OWNER-SENTINEL', 'LANE-SENTINEL', 'PR-SENTINEL', 'SHA-SENTINEL', 'TARGET-SENTINEL', 'OWNER-NOTE', 'since 10:00', 'github.com', 'deadbeef']) {
      assert.equal(html.includes(sentinel), false, sentinel);
    }
    for (const word of ['Russell', 'Grok', 'Claude', 'Desktop', 'lane', 'rule 16', 'draft PR', 'admitPub', 'shareSlotRoot', 'queuedRewardClaim', 'SHA-512', 'PR 130']) {
      assert.doesNotMatch(html, new RegExp(word, 'i'), word);
    }
    const heads = [...html.matchAll(/<th[^>]*>([^<]*)<\/th>/g)].map((m) => m[1]);
    assert.deepEqual(heads, PUBLIC_COLUMNS);
    const rows = publicRows(parseRoadmap(doc(ROWS)));
    for (const r of rows) assert.deepEqual(Object.keys(r), PUBLIC_COLUMNS, r.Row);
  });

  it('the title is the public title, verbatim; a listed row without one fails the build', () => {
    const byId = Object.fromEntries(publicRows(parseRoadmap(doc(ROWS))).map((r) => [r.Row, r]));
    assert.equal(byId.R29.Title, 'Pool share hardening');
    assert.equal(byId.R01b.Title, 'Vault claim post from the wallet');
    assert.equal(byId.R28.Title, 'BluNotes: private share payees and payouts');
    assert.equal(byId.R33.Title, 'Share batch hardening');
    assert.equal(byId.R29.Type, 'Y');
    assert.equal(byId.R09.Type, 'N');
    const missing = doc([row(1, 'R50', 'A finding with a long internal name', '', 'N', 'planned')]);
    assert.throws(() => buildRoadmapPage(missing, { commit: COMMIT }), /R50.*public title/);
    // A dropped row needs none.
    const dropped = doc([row(1, 'R51', 'Old work', '', 'N', 'done')]);
    assert.doesNotMatch(buildRoadmapPage(dropped, { commit: COMMIT }), /R51/);
    // The table without the column at all is refused.
    const noColumn = doc(ROWS).replace('| Public title ', '| Other ').replace('|--------------', '|-------');
    assert.throws(() => buildRoadmapPage(noColumn, { commit: COMMIT }), /Public title/);
  });

  it('the deny-list is a case-insensitive backstop: each internal class fails the build', () => {
    const classes = {
      ip: 'Node health at 203.0.113.7 wobbles',
      'pr label': 'Tests from pr 2',
      'pr label with suffix': 'Fixtures from PR 3a',
      'goal label': 'goal 10 F hardening',
      'lane name': 'Pool Share LANE review',
      'host name': 'Rebuild AGENT-BOX first',
      'host name p2p': 'p2p-a and p2p-b rebuilt',
      email: 'Ask ops@example.org',
      'file path': 'Check crypto/hash_owed.js:381',
      'file path without line': 'Fix node/src/chain.js',
      'owner name': 'russell to rule',
      'agent name': 'cos routes this',
      pid: 'Watch PID 4242',
    };
    for (const [name, title] of Object.entries(classes)) {
      const planted = doc([row(1, 'R50', 'Plain item', title, 'N', 'planned')]);
      assert.throws(() => buildRoadmapPage(planted, { commit: COMMIT }), /public-safety/, name);
    }
    const hostCol = doc([row(1, 'R51', 'Plain item', 'Plain title', 'N', 'planned')])
      .replace('| Target |', '| Target | Host |').replace('|--------|\n', '|--------|------|\n').replace('2 Nov TARGET-SENTINEL |', '2 Nov TARGET-SENTINEL | 198.51.100.9 |');
    const html = buildRoadmapPage(hostCol, { commit: COMMIT });
    assert.equal(html.includes('198.51.100.9'), false);
    assert.equal(html.includes('Host'), false);
    assert.match(html, /R51/);
  });

  it('an escaped pipe stays inside its cell', () => {
    const { header, rows } = parseRoadmap(doc([row(1, 'R52', 'Left \\| right in one cell', 'A title with a \\| bar', 'N', 'planned')]));
    assert.equal(header.length, 12);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].Item, 'Left | right in one cell');
    assert.equal(rows[0]['Public title'], 'A title with a | bar');
    assert.equal(rows[0].Status, 'planned');
    const html = buildRoadmapPage(doc([row(1, 'R52', 'Left \\| right', 'Title with a \\| bar', 'N', 'planned')]), { commit: COMMIT });
    assert.match(html, /Title with a \| bar/);
  });

  it('rows come out in Priority order; unranked rows last, in their written order', () => {
    const ids = publicRows(parseRoadmap(doc(ROWS))).map((r) => r.Row);
    assert.deepEqual(ids, ['R01b', 'R29', 'R40', 'R28', 'R33', 'R09']);
  });

  it('is deterministic: same input, same bytes, and names its source commit', () => {
    const a = buildRoadmapPage(doc(ROWS), { commit: COMMIT });
    const b = buildRoadmapPage(doc(ROWS), { commit: COMMIT });
    assert.equal(a, b);
    assert.match(a, new RegExp(`generated from docs/ROADMAP\\.md at ${COMMIT.slice(0, 12)}`));
    assert.notEqual(a, buildRoadmapPage(doc(ROWS), { commit: 'f'.repeat(40) }));
  });

  it('uses the site chrome and CSS, makes no external request, and adds no navbar link', () => {
    const html = buildRoadmapPage(doc(ROWS), { commit: COMMIT });
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
    const html = buildRoadmapPage(doc(ROWS), { commit: COMMIT });
    const style = html.match(/<style>([\s\S]*?)<\/style>/)?.[1] || '';
    assert.ok(style.length > 0);
    assert.doesNotMatch(style, /#07090c/i);
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
    const html = buildRoadmapPage(doc(ROWS), { commit: COMMIT });
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
    assert.match(footer, /<div data-shear-foot data-wallet-fallback="0\.71" data-network-fallback="shear-testnet-v11">Shear · … · Continuum … · …<\/div>/);
    assert.match(html, /<script src="\.\.\/shared\/site-identity\.js"><\/script>/);
    assert.ok(html.indexOf('generated from docs/ROADMAP.md') < html.indexOf('<footer'), 'the source line sits above the footer');
  });
});

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
    assert.doesNotMatch(page, /\b\d{1,3}(?:\.\d{1,3}){3}\b/);
  });

  it('every listed row of docs/ROADMAP.md has a public title and no internal label reaches the page', () => {
    const page = read('site/roadmap/index.html');
    const cells = [...page.matchAll(/<td>([^<]*)<\/td>/g)].map((m) => m[1]);
    assert.ok(cells.length >= 5 * 10, 'the page has rows');
    for (const cell of cells) {
      assert.doesNotMatch(cell, /\bPRs?\s*#?\d|\bGoals?\s*\d|\blane\b|agent-box|p2p-[a-z]|@|\.(?:js|dart|rs|md)\b/i, cell);
    }
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
    assert.doesNotMatch(claude, /agent-box|p2p-a|p2p-b|DONE\.jsonl|\/root\//);
    assert.match(claude, /Test hosts and their limits are listed in CLAUDE\.local\.md\./);
    assert.match(claude, /CLAUDE\.local\.md/);
    const ignored = read('.gitignore');
    assert.match(ignored, /^CLAUDE\.local\.md\r?$/m);
    const tracked = execFileSync('git', ['ls-files', '--', 'CLAUDE.local.md'], { cwd: repoRoot, encoding: 'utf8' }).trim();
    assert.equal(tracked, '', 'CLAUDE.local.md is not tracked');
  });
});
