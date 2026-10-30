import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
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

const HEADER = '| Priority | ID | Item | Consensus? | Status | Owner | Reviewer | Working now | PR | Head SHA | Target |\n'
  + '|----------|----|------|------------|--------|-------|----------|-------------|----|----------|--------|\n';

function doc(rows) {
  return `# Shear roadmap\n\n## Rows\n\nIntro text.\n\n${HEADER}${rows.join('\n')}\n\n**Note.** After the table.\n`;
}

const ROWS = [
  '| 3 | R29 | Hash-note admitPub not bound to the miner (share research H4, **high**; OWNER-NOTE Russell 27 Oct) | Y: a pin move | planned (filed, not fixed; Russell 27 Oct) | Claude OWNER-SENTINEL | Grok + Pool Share LANE-SENTINEL | claude, claude/x, since 10:00 | [#999](https://github.com/x/y/pull/999) PR-SENTINEL | deadbeef SHA-SENTINEL | 2 Nov TARGET-SENTINEL |',
  '| 2 | R01b | Vault claim post: pool `queuedRewardClaim` takes the FS-1 claim body the wallet sends. **Russell 27 Oct:** more notes | Y: the block-decode revive | planned | Claude | Grok | | | | after R01 |',
  '|  | R01 | PR 130: digestTx and bundled fixes | Y: pins | merged | Claude | Grok | | [#130](https://github.com/x/y/pull/130) | d19c1046 | 28 Oct |',
  '| 9 | R28 | BluNotes: private share payees and payouts, plus pruning (R28; design on Desktop) | Y: one pin move | coding (rule 16; Russell GO 27 Oct; draft PR on claude/r28-blunotes) | Claude | Grok | claude, claude/r28, since 09:00 | | | 5 Nov |',
  '|  | R09 | Token spec (mint.shear.digital), spec only: the first half | N: spec | planned (post-mainnet) | Claude | | | | | none |',
  '| 9 | R33 | Share frame `lz` and frame order not canonical in shareSlotRoot (H10, **low**) | Y | planned (filed, not fixed; Russell 27 Oct) | Claude | Grok | | | | with R28 |',
  '| 24 | R19 | Mainnet genesis | Y: genesis | done | Claude | Grok | | | | 21 Dec |',
  '| 24 | R16 | v12 cut (onto the rebuilt hosts), run from the R16 cut checklist | N | closed | Claude | Grok | | | | Dec |',
];

describe('roadmap page generator', () => {
  it('rows whose status is done, closed or merged drop off', () => {
    const rows = publicRows(parseRoadmap(doc(ROWS)));
    const ids = rows.map((r) => r.Row);
    assert.deepEqual(ids.sort(), ['R01b', 'R09', 'R28', 'R29', 'R33'].sort());
    for (const gone of ['R01', 'R19', 'R16']) assert.equal(ids.includes(gone), false, gone);
  });

  it('only the allow-listed columns reach the page, by name', () => {
    assert.deepEqual(PUBLIC_COLUMNS, ['Priority', 'Row', 'Title', 'Status', 'Type']);
    const html = buildRoadmapPage(doc(ROWS), { commit: COMMIT });
    for (const sentinel of ['OWNER-SENTINEL', 'LANE-SENTINEL', 'PR-SENTINEL', 'SHA-SENTINEL', 'TARGET-SENTINEL', 'OWNER-NOTE', 'since 10:00', 'github.com', 'deadbeef']) {
      assert.equal(html.includes(sentinel), false, sentinel);
    }
    for (const word of ['Russell', 'Grok', 'Claude', 'Desktop', 'lane', 'rule 16', 'draft PR']) {
      assert.doesNotMatch(html, new RegExp(word, 'i'), word);
    }
    const heads = [...html.matchAll(/<th[^>]*>([^<]*)<\/th>/g)].map((m) => m[1]);
    assert.deepEqual(heads, PUBLIC_COLUMNS);
    const rows = publicRows(parseRoadmap(doc(ROWS)));
    for (const r of rows) assert.deepEqual(Object.keys(r), PUBLIC_COLUMNS, r.Row);
  });

  it('a title is the lead clause only; status and type are normalised tokens', () => {
    const byId = Object.fromEntries(publicRows(parseRoadmap(doc(ROWS))).map((r) => [r.Row, r]));
    assert.equal(byId.R29.Title, 'Hash-note admitPub not bound to the miner');
    assert.equal(byId.R01b.Title, 'Vault claim post');
    assert.equal(byId.R28.Title, 'BluNotes');
    assert.equal(byId.R33.Title, 'Share frame lz and frame order not canonical in shareSlotRoot');
    assert.equal(byId.R29.Status, 'planned');
    assert.equal(byId.R28.Status, 'active');
    assert.equal(byId.R29.Type, 'Y');
    assert.equal(byId.R09.Type, 'N');
    assert.equal(byId.R09.Status, 'planned');
  });

  it('a planted IP-like string never reaches the output: the build refuses', () => {
    const planted = doc([
      '| 1 | R50 | Node health at 203.0.113.7 wobbles | N | planned | Claude | | | | | soon |',
    ]);
    assert.throws(() => buildRoadmapPage(planted, { commit: COMMIT }), /public-safety/);
    const hostCol = doc([
      '| 1 | R51 | Plain title | N | planned | Claude | | | | | soon |',
    ]).replace('| Target |', '| Target | Host |').replace('|--------|\n', '|--------|------|\n').replace('| soon |', '| soon | 198.51.100.9 |');
    const html = buildRoadmapPage(hostCol, { commit: COMMIT });
    assert.equal(html.includes('198.51.100.9'), false);
    assert.equal(html.includes('Host'), false);
    assert.match(html, /R51/);
  });

  it('rows come out in Priority order; unranked rows last, in their written order', () => {
    const ids = publicRows(parseRoadmap(doc(ROWS))).map((r) => r.Row);
    assert.deepEqual(ids, ['R01b', 'R29', 'R28', 'R33', 'R09']);
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
    assert.match(html, /id="shear-chrome-root" data-active="DOCS" data-brand-base="\.\.\/brand\/"/);
    assert.match(html, /src="\.\.\/shared\/shear-chrome\.js"/);
    for (const m of html.matchAll(/(?:src|href)="([^"]+)"/g)) {
      assert.doesNotMatch(m[1], /^(https?:)?\/\//, m[1]);
    }
    assert.doesNotMatch(html, /@import|fonts\.googleapis|<iframe|analytics|gtag|fetch\(|XMLHttpRequest/);
    assert.doesNotMatch(html, /nav-btn/);
    assert.match(html, /<table[^>]*class="roadmap"/);
  });

  it('the committed page is the current build of docs/ROADMAP.md', () => {
    const page = fs.readFileSync(path.join(repoRoot, 'site', 'roadmap', 'index.html'), 'utf8');
    const md = fs.readFileSync(path.join(repoRoot, 'docs', 'ROADMAP.md'), 'utf8');
    const commit = page.match(/generated from docs\/ROADMAP\.md at ([0-9a-f]{12})/)?.[1];
    assert.ok(commit, 'the page names its source commit');
    assert.equal(page, buildRoadmapPage(md, { commit }));
    assert.doesNotMatch(page, /\b\d{1,3}(?:\.\d{1,3}){3}\b/);
  });
});
