import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as page from '../../scripts/build_roadmap_page.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.join(here, '../..');
const read = (p) => fs.readFileSync(path.join(repoRoot, p), 'utf8');
const { PUBLIC_COLUMNS, buildRoadmapPage, parseRoadmap, publicRows } = page;

/** Synthetic deny hashes: the hash is written out here, not computed by the code under test. */
const SALT = '0123456789abcdef0123456789abcdef';
const sha = (canonical) => createHash('sha256').update(`${SALT}:${canonical}`).digest('hex');
const DENY_HASHES = Object.freeze({ salt: SALT, hashes: [sha('zzhost'), sha('quillwarddesk')] });

const HEADER = '| Priority | ID | Public title | Type | Status | Ref |\n'
  + '|----------|----|--------------|------|--------|-----|\n';

/** A doc with the public table, then text after it that the build must never put on the page. */
function doc(rows, header = HEADER) {
  return `# Shear roadmap\n\n## Rows\n\nIntro text.\n\n${header}${rows.join('\n')}\n\n`
    + '**Note.** DETAIL-SENTINEL after the table.\n';
}

let refSeq = 0;
/** A public row: [priority, id, public title, type, status, ref]; a fresh ref unless one is given. */
function row(priority, id, title, type, status, ref) {
  refSeq += 1;
  const r = ref ?? `rf-${refSeq.toString(16).padStart(10, '0')}`;
  return `| ${priority} | ${id} | ${title} | ${type} | ${status} | ${r} |`;
}

const ROWS = [
  row(3, 'R29', 'Pool share payee checks', 'Y', 'planned'),
  row(2, 'R01b', 'Vault claim post from the wallet', 'Y', 'planned'),
  row('', 'R01', 'Transaction digest update', 'Y', 'merged'),
  row(9, 'R28', 'BluNotes: hidden share payees and payouts', 'Y', 'coding'),
  row('', 'R09', 'Token spec', 'N', 'planned'),
  row(9, 'R33', 'Share batch encoding', 'Y', 'planned'),
  row(24, 'R19', 'Mainnet genesis', 'Y', 'Done.'),
  row(24, 'R16', 'v12 cut', 'N', 'closed'),
  row(24, 'R17', 'Stressnet', 'N', 'Shipped'),
  row(24, 'R18b', 'Mainnet release deploy', 'N', 'Deployed'),
  row(5, 'R40', 'Hash key derivation', 'Y', 'ruled'),
];

const opts = (o = {}) => ({ denyHashes: DENY_HASHES, ...o });
const build = (rows, o) => buildRoadmapPage(doc(rows), opts(o));
const rowsOf = (rows, o) => publicRows(parseRoadmap(doc(rows)), opts(o));
const planted = (title, o) => build([row(1, 'R50', title, 'N', 'planned')], o);

describe('roadmap page generator', () => {
  it('rows whose status is done, closed, merged, shipped or deployed drop off', () => {
    const ids = rowsOf(ROWS).map((r) => r.Row);
    assert.deepEqual(ids.sort(), ['R01b', 'R09', 'R28', 'R29', 'R33', 'R40'].sort());
    for (const gone of ['R01', 'R19', 'R16', 'R17', 'R18b']) assert.equal(ids.includes(gone), false, gone);
  });

  it('a status outside the vocabulary fails the build; an empty one too', () => {
    for (const status of ['', 'soon', 'blocked', 'planed']) {
      assert.throws(() => build([row(1, 'R50', 'Plain title', 'N', status)]), /status/, JSON.stringify(status));
    }
    const byId = Object.fromEntries(rowsOf(ROWS).map((r) => [r.Row, r]));
    assert.equal(byId.R29.Status, 'planned');
    assert.equal(byId.R28.Status, 'active');
    assert.equal(byId.R40.Status, 'ruled');
  });

  it('the public table carries exactly Priority, ID, Public title, Type, Status and Ref; more fails the build', () => {
    assert.deepEqual(PUBLIC_COLUMNS, ['Priority', 'Row', 'Title', 'Status', 'Type']);
    const html = build(ROWS);
    for (const sentinel of ['DETAIL-SENTINEL', 'rf-', '>Ref<']) {
      assert.equal(html.includes(sentinel), false, sentinel);
    }
    const heads = [...html.matchAll(/<th[^>]*>([^<]*)<\/th>/g)].map((m) => m[1]);
    assert.deepEqual(heads, PUBLIC_COLUMNS);
    for (const extra of ['Item', 'Owner', 'Host']) {
      const wide = HEADER.replace('| Ref |', `| Ref | ${extra} |`).replace('|-----|\n', '|-----|------|\n');
      const rows = [`${row(1, 'R50', 'Plain title', 'N', 'planned')} internal ${extra.toLowerCase()} text |`];
      assert.throws(() => buildRoadmapPage(doc(rows, wide), opts()), /public table/, extra);
    }
    const extraCell = `${row(1, 'R50', 'Plain title', 'N', 'planned')} smuggled detail |`;
    assert.throws(() => build([extraCell]), /R50.*cells/);
    const old = HEADER.replace('| Ref |', '| Private ref |').replace('|-----|', '|-------------|');
    assert.throws(() => buildRoadmapPage(doc([row(1, 'R50', 'Plain title', 'N', 'planned')], old), opts()), /public table/, 'the first-round column name');
  });

  it('every row carries a ref, so the column marks no kind of row: rf- and ten hex digits, unique; empty or other forms fail', () => {
    for (const ref of ['', 'pt-0a1b2c', 'H5 pool share', 'see R29', 'rf-zzzzzzzzzz', 'rf-0a1b2c3d4', 'rf-0a1b2c3d4e5', 'RF-0A1B2C3D4E']) {
      assert.throws(() => build([row(1, 'R50', 'Plain title', 'N', 'planned', ref)]), /ref/, JSON.stringify(ref));
    }
    assert.match(build([row(1, 'R50', 'Plain title', 'N', 'planned', 'rf-abc1230def')]), /R50/);
    const twice = [row(1, 'R50', 'Plain title', 'N', 'planned', 'rf-abc1230def'), row(2, 'R51', 'Other title', 'N', 'planned', 'rf-abc1230def')];
    assert.throws(() => build(twice), /R51.*ref/);
  });

  it('Status is exactly one vocabulary word and Priority is empty or a number: no free text', () => {
    for (const status of ['planned (filed, not fixed)', '**planned** see notes', 'planned: H5 work', 'coding (rule 16)', 'Done. 29 Oct', 'Ruled 28 Oct']) {
      assert.throws(() => build([row(1, 'R50', 'Plain title', 'N', status)]), /status/, status);
    }
    for (const status of ['planned', 'active', 'coding', 'in review', 'awaiting GO', 'ruled', 'merged', 'done', 'closed', 'shipped', 'deployed', 'Planned', '**planned**']) {
      assert.doesNotThrow(() => build([row(1, 'R50', 'Plain title', 'N', status)]), status);
    }
    for (const priority of ['high', '3 (after R29)', 'P1', '2a', '-1']) {
      assert.throws(() => build([row(priority, 'R50', 'Plain title', 'N', 'planned')]), /priority/i, priority);
    }
    assert.match(build([row('', 'R50', 'Plain title', 'N', 'planned')]), /R50/);
  });

  it('every row needs a public title, a dropped row too', () => {
    const byId = Object.fromEntries(rowsOf(ROWS).map((r) => [r.Row, r]));
    assert.equal(byId.R29.Title, 'Pool share payee checks');
    assert.equal(byId.R01b.Title, 'Vault claim post from the wallet');
    assert.equal(byId.R29.Type, 'Y');
    assert.equal(byId.R09.Type, 'N');
    assert.throws(() => build([row(1, 'R50', '', 'N', 'planned')]), /R50.*public title/);
    assert.throws(() => build([row(1, 'R51', '', 'N', 'done')]), /R51.*public title/);
  });

  it('a row ID must match ^R\\d{2}[a-z]?$', () => {
    for (const id of ['R1', 'R001', 'R01B', 'X01', 'R01-a', 'r01', 'R01ab', 'R\uFF101', 'R01\u200B', 'R 01']) {
      assert.throws(() => build([row(1, id, 'Plain title', 'N', 'planned')]), /ID/, JSON.stringify(id));
    }
    const ids = rowsOf(['R01', 'R01b', 'R40', 'R99z'].map((id) => row(1, id, 'Plain title', 'N', 'planned'))).map((r) => r.Row);
    assert.deepEqual(ids, ['R01', 'R01b', 'R40', 'R99z']);
  });

  it('titles are NFKC-normalised with zero-width characters stripped, and must then be plain ASCII', () => {
    assert.match(planted('\uFF30\uFF4F\uFF4F\uFF4C checks'), /<td>Pool checks<\/td>/);
    assert.match(planted('Pool\u200B share\u2060 pay\uFEFFees'), /<td>Pool share payees<\/td>/);
    for (const title of ['Caf\u00E9 scan', 'Pool \u2014 checks', 'Wallet \u{1F512} scan', 'Wallet na\u00EFve scan']) {
      assert.throws(() => planted(title), /plain ASCII/, JSON.stringify(title));
    }
    assert.throws(() => planted('\uFF23\uFF36\uFF25-2024-12345 fix'), /public-safety/, 'fullwidth CVE');
    assert.throws(() => planted('Pool expl\u200Boit fix'), /public-safety/, 'zero-width split');
    assert.throws(() => planted('\uFF28\uFF15 fix'), /public-safety/, 'fullwidth finding code');
  });

  it('neutral titles pass the deny-list', () => {
    for (const title of ['x64 build', 'x86 baseline', 'Mining-pool fee view', 'v12 cut', 'Android ABIs beyond arm64-v8a', 'P2P relay', 'Dev-network pin move',
      'Wallet light mode scan', 'ShearK-Miner optimisation', 'Reserve epoch, withdraw and claim follow-ups', 'Stressnet (7-day floor)', 'Public supply audit tool',
      'Pool share payee checks', 'Share batch encoding', 'Share header window', 'Hash-bonus record root', 'Native hash threading', 'Confidential tokens build', 'Sandbox wallet']) {
      assert.match(planted(title), /R50/, title);
    }
  });

  const DENIED = {
    'finding code H5': 'Pool fix for H5',
    'finding code F-2': 'F-2 follow-up',
    'finding code K-1a': 'K-1a closure',
    'finding code N4': 'Relay N4 fix',
    'finding code with a letter suffix': 'H5a closure',
    'finding code with three digits': 'Fix for H123',
    'multi-letter finding code': 'PA3 follow-up',
    'multi-letter code with a dash': 'Pool PA-3 work',
    'multi-letter code with an underscore': 'SEC_12 closure',
    'code with a dot': 'Item H.5 closure',
    'four-letter code': 'WALL-7 follow-up',
    'spaced upper-case code': 'Pool PA 3 work',
    'priority label P0-P3': 'p1 wallet fix',
    'severity word critical': 'Critical vault fix',
    'severity form critically': 'Critically needed vault fix',
    'severity word high': 'High pool fix',
    'severity form highest': 'Highest pool item',
    'severity word medium': 'MEDIUM share fix',
    'severity plural mediums': 'Two mediums closed',
    'severity word low': 'low ledger fix',
    'severity form lows': 'Ledger lows closed',
    'severity form severity': 'Severity review',
    'severity plural severities': 'Mixed severities closed',
    'severity form severely': 'Severely broken pool',
    'exploit word': 'Exploitable share path',
    'exploit plural': 'Share exploits closed',
    'vuln word': 'Vault vulnerability fix',
    'leak word': 'Wallet privacy leak',
    'leak form leaked': 'Leaked wallet data',
    'bypass word': 'Fee bypass closed',
    'grief word': 'Pool griefing guard',
    'attack word': 'Share attack guard',
    'attack form attackers': 'Stop attackers',
    'flaw word': 'Ledger flaw',
    'flaw form flawed': 'Flawed share rule',
    'weakness word': 'Pool weaknesses',
    'breach word': 'Vault breach',
    'compromise word': 'Compromised key rotation',
    'injection word': 'Header injection guard',
    'overflow word': 'Owed overflow guard',
    'forgery word': 'Proof forgery guard',
    'forge form forged': 'Forged share refusal',
    'spoof word': 'Peer spoofing guard',
    'hijack word': 'Session hijack guard',
    'tamper word': 'Tampered proof refusal',
    'malleability word': 'Share malleability',
    'grinding word': 'Header grinding guard',
    'DoS word': 'Relay DoS guard',
    'hardening word': 'Pool share hardening',
    'harden form hardened': 'Hardened vault path',
    'security word': 'Wallet security fixes',
    'insecure word': 'Insecure default removed',
    'CVE id': 'Patch for cve-2024-12345',
    'lane name': 'Pool Share LANE review',
    'lane plural': 'Two lanes signed',
    'lane role': 'Ledger auditor follow-up',
    'lane role plural': 'Auditors signed off',
    'lane role assailants': 'Assailants retest',
    'lane role evaluators': 'Evaluators signed',
    'lane role evaluation': 'Evaluation round',
    'lane role reviewers': 'Reviewers asked',
    'red team': 'Red-team findings',
    'pen test': 'Pen testing round',
    'private wording': 'Private share payees',
    hostname: 'Move to admin.example.org',
    'hostname shape -box': 'Rebuild build-box first',
    'hostname shape _box': 'Rebuild build_box first',
    'hostname shape p2p-x': 'Rebuild p2p-q first',
    'hostname shape p2p_x': 'Rebuild p2p_q first',
    'hostname shape p2p x': 'Rebuild p2p q first',
    'hostname shape -soak': 'Move win-soak to the new OS',
    'hostname shape node digits': 'Retire relaynode7',
    ip: 'Node health at 203.0.113.7 wobbles',
    'pr label': 'Tests from pr 2',
    'pr label with suffix': 'Fixtures from PR 3a',
    'goal label': 'goal 10 F wallet',
    email: 'Ask ops@example.org',
    'file path': 'Check crypto/hash_owed.js:381',
    'file path without line': 'Fix node/src/chain.js',
    'owner name': 'russell to rule',
    'agent name': 'cos routes this',
    pid: 'Watch PID 4242',
    'severity form severest': 'Severest share item',
    'severity short form sev': 'Hi-sev pool item',
    'code with a slash': 'PA/3 follow-up',
    'lower-case spaced code': 'pool pa 3 work',
    'weak word': 'Weak share rule',
    'lane form red teamers': 'Red teamers retest',
    'lane form reviewing': 'Reviewing round two',
    'lane form assessors': 'Assessors signed',
    'lane form testers': 'Testers signed',
    'replay word': 'Share replay guard',
    'double-spend word': 'Double-spend guard',
    'crash word': 'Relay crash on decode',
    'race word': 'Race in the owed ledger',
    'fraud word': 'Payout fraud check',
    'cheat word': 'Miner cheating check',
    'abuse word': 'Faucet abuse limits',
    'exposure word': 'View key exposure',
    'disclosure word': 'Balance disclosure fix',
    'unauthorised word': 'Unauthorised withdraw path',
    'escalation word': 'Admin escalation path',
    'web attack acronym': 'Admin XSS fix',
    'sybil word': 'Sybil share flood',
    'eclipse word': 'Peer eclipse guard',
    'poisoning word': 'Cache poisoning guard',
    'impersonation word': 'Node impersonation guard',
    'counterfeit word': 'Counterfeit note check',
    'loophole word': 'Fee loophole closed',
    'panic word': 'Decoder panic on input',
  };
  for (const [name, title] of Object.entries(DENIED)) {
    it(`the deny-list refuses a ${name}, in any case`, () => {
      assert.throws(() => planted(title), /public-safety/, title);
    });
  }

  it('hashed deny terms are refused in any spelling: spaced, dashed, underscored, joined, any case', () => {
    for (const title of ['Rebuild zz-host first', 'Rebuild ZZ host first', 'Rebuild zz_host first', 'Rebuild zzhost first', 'Rebuild ZzHost first', 'Rebuild z\u200Bz-host first',
      'quill ward desk sign-off', 'Quill_Ward_Desk sign-off', 'QuillWardDesk sign-off', 'Quill-Ward desk sign-off']) {
      assert.throws(() => planted(title, { deny: [] }), /public-safety.*deny-list/, title);
    }
    assert.match(planted('Rebuild the zz cluster host first', { deny: [] }), /R50/, 'only a whole run of the term');
    assert.match(planted('Quill and ward desk sign-off', { deny: [] }), /R50/, 'the words apart are not the term');
    for (const title of ['Two zz hosts', 'Rebuild zzhosts first', 'Rebuild zz-hostes first', 'Rebuild zz host2 first', 'Rebuild ZzHost07 first', 'QuillWardDesks sign-off']) {
      assert.equal(page.namesHashedTerm(title, DENY_HASHES), true, title);
      assert.throws(() => planted(title, { deny: [] }), /public-safety.*deny-list/, title);
    }
    assert.equal(page.namesHashedTerm('Rebuild the cluster first', DENY_HASHES), false);
  });

  it('plain tracker terms are refused too, in any case, and only when listed', () => {
    const deny = ['build-host-zz', 'Another Term'];
    assert.throws(() => planted('Rebuild BUILD-HOST-ZZ first', { deny }), /public-safety/);
    assert.throws(() => planted('another term sign-off', { deny }), /public-safety/);
    assert.throws(() => planted('Rebuild build\u200B-host-zz first', { deny }), /public-safety/);
    assert.match(planted('Rebuild the build host first', { deny }), /R50/);
  });

  it('fails closed without deny hashes: missing, empty, malformed or a bad salt', () => {
    for (const denyHashes of [undefined, null, {}, { salt: SALT, hashes: [] }, { salt: 'short', hashes: [sha('x')] }, { salt: SALT, hashes: ['nothex'] }]) {
      assert.throws(() => buildRoadmapPage(doc(ROWS), { denyHashes }), /deny hashes/, JSON.stringify(denyHashes));
      assert.throws(() => publicRows(parseRoadmap(doc(ROWS)), { denyHashes }), /deny hashes/, JSON.stringify(denyHashes));
    }
  });

  it('docs/ROADMAP.md as a whole may carry no host detail: machine names, providers, laptop paths, addresses, deny terms', () => {
    const base = doc(ROWS);
    assert.doesNotThrow(() => page.assertPublicDoc(base, opts()));
    for (const leak of ['Rebuild build-box first.', 'Rebuild p2p-q first.', 'Rebuild p2p_q first.', 'Check whether Hetzner keeps the IP.', 'Rent a VPS.',
      'Design note: Desktop notes/r28.md.', 'Logs in /root/claude-ci.', 'Host 203.0.113.7.', 'Measured on the zz host.', 'Measured on zz_host.', 'Reviewed by QuillWardDesk.',
      'Notes in C:/Users/ops/notes.', 'Notes in /Users/ops/notes.', 'Notes in ~/notes.', 'Peer at 2001:db8:0:1::7.', 'Open ports 22, 80, 443 and 30303 only.']) {
      assert.throws(() => page.assertPublicDoc(`${base}\n${leak}\n`, opts()), /public-safety/, leak);
      assert.throws(() => buildRoadmapPage(`${base}\n${leak}\n`, opts()), /public-safety/, `build: ${leak}`);
    }
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
    const ids = rowsOf(ROWS).map((r) => r.Row);
    assert.deepEqual(ids, ['R01b', 'R29', 'R40', 'R28', 'R33', 'R09']);
  });

  it('is deterministic: same input, same bytes; the stamp is the source digest, so a squash merge leaves the page current', () => {
    const md = doc(ROWS);
    const a = buildRoadmapPage(md, opts());
    assert.equal(a, buildRoadmapPage(md, opts()));
    const digest = createHash('sha256').update(md).digest('hex').slice(0, 12);
    assert.ok(a.includes(`generated from docs/ROADMAP.md (sha256 ${digest})`), 'names its source digest');
    assert.equal(buildRoadmapPage(md.replace(/\n/g, '\r\n'), opts()), a, 'line endings do not move the stamp');
    assert.notEqual(buildRoadmapPage(`${md}\nMore text.\n`, opts()), a);
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

  it('carries the five-link footer and the styled maturity line, and the footer fetches nothing', () => {
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
    assert.match(footer, /<p class="footer-maturity">Experimental testnet software, coins have no value\.<\/p>/);
    const style = html.match(/<style>([\s\S]*?)<\/style>/)?.[1] || '';
    assert.match(style, /\.footer-maturity \{[^}]*color: var\(--text-dim\)[^}]*\}/, 'the maturity line has its own style, in tokens');
    assert.doesNotMatch(html, /site-identity\.js|data-shear-foot/, 'the identity script fetches the pool and GitHub; the page does not load it');
    const scripts = [...html.matchAll(/<script\b[^>]*src="([^"]+)"/g)].map((m) => m[1]);
    assert.deepEqual(scripts, ['../shared/shear-chrome.js'], 'the chrome script is the only script');
    assert.ok(html.indexOf('generated from docs/ROADMAP.md') < html.indexOf('<footer'), 'the source line sits above the footer');
  });
});

/** Terms the page must never show: the deny classes, checked again on the committed page. */
const PAGE_DENIED = [
  /\b(?!v\d|x(?:64|86)\b|arm64\b|p2p\b)[a-z]{1,4}[-_.]?\d{1,3}[a-z]?\b/i,
  /\bP[0-3]\b/i,
  /\b(?:critical|high|medium|low|sever)/i,
  /\b(?:exploit|vuln|leak|bypass|grief|attack|flaw|weakness|harden|secur|forg|spoof|tamper|malleab|grind)/i,
  /\bCVE-\d{4}-\d{4,}\b/i,
  /\b(?:lanes?|auditors?|assailants?|evaluat|reviewers?)\b/i,
  /\bprivate\b/i,
  /\b\d{1,3}(?:\.\d{1,3}){3}\b/,
  /\bPRs?\s*#?\d|\bGoals?\s*\d/i,
  /@|\.(?:js|mjs|dart|rs)\b/i,
];

/** The tracker's deny terms, when the tracker is on this machine (either of its names). */
function trackerTerms() {
  for (const name of ['ROADMAP.tracker.md', 'ROADMAP.private.md']) {
    const p = path.join(repoRoot, 'docs', name);
    if (!fs.existsSync(p)) continue;
    const text = fs.readFileSync(p, 'utf8').split(/^## Page deny list\s*$/m)[1] || '';
    return [...text.matchAll(/^- (.+?)\s*$/gm)].map((m) => m[1]);
  }
  return [];
}

/** The committed salted hashes of the tracker's deny list. */
const committedHashes = () => JSON.parse(read('docs/roadmap-deny.json'));

/** A copy of the build in a temp dir: the script, a ROADMAP.md, the page, and optionally the hash file. */
function scratchRepo({ markdown, hashes }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'roadmap-'));
  fs.mkdirSync(path.join(dir, 'scripts'));
  fs.mkdirSync(path.join(dir, 'docs'));
  fs.mkdirSync(path.join(dir, 'site', 'roadmap'), { recursive: true });
  fs.copyFileSync(path.join(repoRoot, 'scripts', 'build_roadmap_page.mjs'), path.join(dir, 'scripts', 'build_roadmap_page.mjs'));
  fs.writeFileSync(path.join(dir, 'docs', 'ROADMAP.md'), markdown);
  if (hashes) fs.writeFileSync(path.join(dir, 'docs', 'roadmap-deny.json'), JSON.stringify(hashes));
  return dir;
}
const runBuild = (dir, ...args) => spawnSync(process.execPath, [path.join(dir, 'scripts', 'build_roadmap_page.mjs'), ...args], { cwd: dir, encoding: 'utf8', timeout: 60_000 });

describe('the deny list fails closed without the tracker', () => {
  it('a CI-like checkout (no tracker) still refuses a hashed host name on the page', () => {
    const dir = scratchRepo({ markdown: doc([row(1, 'R50', 'Rebuild zz host first', 'N', 'planned')]), hashes: DENY_HASHES });
    try {
      assert.equal(fs.existsSync(path.join(dir, 'docs', 'ROADMAP.tracker.md')), false);
      const run = runBuild(dir);
      assert.notEqual(run.status, 0, 'the build must refuse, not publish');
      assert.match(run.stderr, /public-safety.*deny-list/);
      assert.equal(fs.existsSync(path.join(dir, 'site', 'roadmap', 'index.html')), false, 'no page written');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('with neither the tracker nor the hash file, the build and --check fail; they do not skip the deny list', () => {
    const dir = scratchRepo({ markdown: doc(ROWS) });
    try {
      for (const args of [[], ['--check']]) {
        const run = runBuild(dir, ...args);
        assert.notEqual(run.status, 0, `exit for ${args.join(' ') || 'build'}`);
        assert.match(run.stderr, /deny hashes/);
      }
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('with the hash file and no tracker, a clean doc builds', () => {
    const dir = scratchRepo({ markdown: doc(ROWS), hashes: DENY_HASHES });
    try {
      const run = runBuild(dir);
      assert.equal(run.status, 0, run.stderr);
      assert.match(fs.readFileSync(path.join(dir, 'site', 'roadmap', 'index.html'), 'utf8'), /Pool share payee checks/);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('a deny term the hash path could never match is refused: more than four words, or nothing left after canonical form', () => {
    for (const bad of [['one two three four five'], ['\u00E9\u00E8'], ['  ']]) {
      const hashes = { salt: SALT, hashes: [sha('zzhost')] };
      assert.throws(() => page.assertDenyHashesMatch(bad, hashes), /deny term/, JSON.stringify(bad));
    }
    const tracker = '# T\n\n## Page deny list\n\n- zz-host\n- one two three four five\n';
    const dir = scratchRepo({ markdown: doc(ROWS), hashes: DENY_HASHES });
    try {
      fs.writeFileSync(path.join(dir, 'docs', 'ROADMAP.tracker.md'), tracker);
      const run = runBuild(dir, '--write-deny-hashes');
      assert.notEqual(run.status, 0, 'a five-word term is not written');
      assert.match(run.stderr, /deny term/);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('--check reads the committed page with either line ending', () => {
    const dir = scratchRepo({ markdown: doc(ROWS), hashes: DENY_HASHES });
    try {
      assert.equal(runBuild(dir).status, 0);
      const out = path.join(dir, 'site', 'roadmap', 'index.html');
      fs.writeFileSync(out, fs.readFileSync(out, 'utf8').replace(/\n/g, '\r\n'));
      const run = runBuild(dir, '--check');
      assert.equal(run.status, 0, run.stderr);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('docs/roadmap-deny.json is committed: a 32-hex salt and only sha256 hashes, no term in plain', () => {
    const tracked = execFileSync('git', ['ls-files', '--', 'docs/roadmap-deny.json'], { cwd: repoRoot, encoding: 'utf8' }).trim();
    assert.equal(tracked, 'docs/roadmap-deny.json');
    const h = committedHashes();
    assert.deepEqual(Object.keys(h).sort(), ['hashes', 'salt']);
    assert.match(h.salt, /^[0-9a-f]{32}$/);
    assert.ok(h.hashes.length >= 10, 'the deny list is hashed in full');
    for (const x of h.hashes) assert.match(x, /^[0-9a-f]{64}$/);
    assert.equal(new Set(h.hashes).size, h.hashes.length);
    assert.notEqual(h.salt, SALT, 'not the test salt');
  });

  it('when the tracker is present, the committed hashes are exactly its terms, and every term is refused by the hashes alone in any spelling', (t) => {
    const terms = trackerTerms();
    if (terms.length === 0) { t.skip('no tracker on this machine (CI): covered by the hash-only tests above'); return; }
    const h = committedHashes();
    assert.doesNotThrow(() => page.assertDenyHashesMatch(terms, h));
    for (const term of terms) {
      const words = term.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
      for (const spelling of [term, term.toUpperCase(), words.join(' '), words.join('_'), words.join('-'), words.join('')]) {
        assert.equal(page.namesHashedTerm(`Rebuild ${spelling} first`, h), true, 'a tracker term in one spelling, by the hash path itself');
      }
    }
  });
});

describe('the committed roadmap page and its links', () => {
  it('--check passes: the committed page is the build of docs/ROADMAP.md', () => {
    const run = spawnSync(process.execPath, [path.join(repoRoot, 'scripts', 'build_roadmap_page.mjs'), '--check'], {
      cwd: repoRoot,
      encoding: 'utf8',
      timeout: 60_000,
    });
    assert.equal(run.status, 0, run.stderr || run.stdout);
    assert.match(run.stdout, /is current/);
  });

  it('the page stamp is the digest of docs/ROADMAP.md as committed', () => {
    const html = read('site/roadmap/index.html');
    const md = read('docs/ROADMAP.md');
    const stamped = html.match(/generated from docs\/ROADMAP\.md \(sha256 ([0-9a-f]{12})\)/)?.[1];
    assert.ok(stamped, 'the page names its source digest');
    assert.equal(stamped, createHash('sha256').update(md.replace(/\r\n/g, '\n')).digest('hex').slice(0, 12));
    assert.equal(html, buildRoadmapPage(md, { denyHashes: committedHashes() }));
  });

  it('the rebuilt page shows no denied term: every cell is plain ASCII and clear of each deny class', () => {
    const html = read('site/roadmap/index.html');
    const cells = [...html.matchAll(/<td>([^<]*)<\/td>/g)].map((m) => m[1]);
    assert.ok(cells.length >= 5 * 10, 'the page has rows');
    const titles = cells.filter((_, k) => k % 5 === 2);
    for (const title of titles) {
      assert.match(title, /^[\x20-\x7e]+$/, title);
      for (const re of PAGE_DENIED) assert.doesNotMatch(title, re, `${title} vs ${re}`);
      assert.equal(page.namesHashedTerm(title, committedHashes()), false, title);
      for (const term of trackerTerms()) assert.equal(title.toLowerCase().includes(term.toLowerCase()), false, title);
    }
    for (const id of cells.filter((_, k) => k % 5 === 1)) assert.match(id, /^R\d{2}[a-z]?$/, id);
    assert.ok(html.includes('<td>Wallet light mode scan</td>'), 'R01c carries its title');
    assert.doesNotMatch(html.replace(/<[^>]+>/g, ' '), /\bprivate\b/i, 'no "private" wording anywhere on the page');
    assert.doesNotMatch(titles.join('\n'), /hardening/i, 'the hardening titles are reworded');
  });

  it('docs/ROADMAP.md: a ref on every row, no row detail table, no host detail; the tracker is never committed', () => {
    const md = read('docs/ROADMAP.md');
    const { header, rows } = parseRoadmap(md);
    assert.deepEqual(header, ['Priority', 'ID', 'Public title', 'Type', 'Status', 'Ref']);
    assert.equal(rows.find((r) => r.ID === 'R01c')['Public title'], 'Wallet light mode scan');
    for (const r of rows) assert.match(r.Ref, /^rf-[0-9a-f]{10}$/, `${r.ID} carries a ref`);
    assert.equal(new Set(rows.map((r) => r.Ref)).size, rows.length, 'refs are unique');
    assert.doesNotMatch(md, /\bpt-[0-9a-f]{6}\b/, 'no first-round ref (they marked the security rows)');
    assert.doesNotMatch(md, /^\|\s*ID\s*\|\s*Item\s*\|/m, 'no row detail table');
    assert.doesNotMatch(md, /^### Row detail/m);
    const lines = md.split(/\r?\n/);
    for (const r of rows) {
      const named = lines.filter((l) => new RegExp(`^\\|\\s*${r.ID}\\s*\\|`).test(l));
      assert.deepEqual(named, [], `${r.ID} has no detail line in the public file`);
    }
    assert.doesNotMatch(md, /^\|\s*Host\s*\|/m, 'no host table');
    assert.doesNotMatch(md, /\b(?:ubuntu|debian|fedora)\s+(?:pool|nodes?|hosts?)\b|peering with the \w+ pool/i, 'no OS named for a host role');
    assert.doesNotMatch(md, /\b(?:ufw|nftables|firewalld)\s+on\s+(?:ubuntu|debian|fedora)\b/i, 'no per-OS firewall plan');
    assert.doesNotThrow(() => page.assertPublicDoc(md, { denyHashes: committedHashes(), deny: trackerTerms() }));
    assert.doesNotMatch(md, /\bH\d{1,2}\b/, 'no finding code of the share research');
    assert.doesNotMatch(md, /\*\*(?:high|medium|low)\b/i, 'no severity mark');
    for (const r of rows) {
      assert.match(r.Status, /^(?:planned|active|coding|in review|awaiting GO|ruled|merged|done|closed|shipped|deployed)$/, r.ID);
      assert.match(r.Priority, /^(?:\d+)?$/, r.ID);
    }
    assert.match(md, /tracker[^.]*Owner, Reviewer, Working now and PR/, 'the rules say where a row is claimed');
    assert.doesNotMatch(md, /private tracker|Private ref/i, 'the tracker is not called private');
    const ignored = read('.gitignore');
    for (const name of ['docs/ROADMAP.tracker.md', 'docs/ROADMAP.private.md']) {
      assert.match(ignored, new RegExp(`^${name.replace(/\./g, '\\.')}\\r?$`, 'm'), name);
      const tracked = execFileSync('git', ['ls-files', '--', name], { cwd: repoRoot, encoding: 'utf8' }).trim();
      assert.equal(tracked, '', `${name} is not tracked`);
    }
  });

  it('CI runs the page check and these tests on every push and pull request', () => {
    const wf = read('.github/workflows/roadmap-page.yml');
    assert.match(wf, /^on:\s*\n\s+push:\s*\n\s+pull_request:/m);
    assert.match(wf, /node scripts\/build_roadmap_page\.mjs --check/);
    assert.match(wf, /node --test site\/tests\/test_roadmap_page\.js/);
    assert.doesNotMatch(wf, /ROADMAP\.(?:tracker|private)\.md/, 'CI never has the tracker; the hashes stand in for it');
    assert.match(wf, /^permissions:\s*\n\s+contents: read/m, 'the job only reads');
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
    assert.equal(page.namesHashedTerm(claude, committedHashes()), false, 'a deny-list term');
    assert.match(claude, /Test hosts and their limits are listed in CLAUDE\.local\.md\./);
    const ignored = read('.gitignore');
    assert.match(ignored, /^CLAUDE\.local\.md\r?$/m);
    const tracked = execFileSync('git', ['ls-files', '--', 'CLAUDE.local.md'], { cwd: repoRoot, encoding: 'utf8' }).trim();
    assert.equal(tracked, '', 'CLAUDE.local.md is not tracked');
  });

  it('.gitignore names no operator vhost: untracked deploy/nginx-*.conf files are ignored, the public ones re-included by name', () => {
    const lines = read('.gitignore').split(/\r?\n/);
    assert.ok(lines.includes('deploy/nginx-*.conf'), 'the generic vhost pattern');
    for (const l of lines.filter((x) => x.startsWith('deploy/nginx-'))) {
      assert.ok(l.includes('*'), `a named vhost ignored in .gitignore: line ${lines.indexOf(l) + 1}`);
    }
    assert.equal(page.namesHashedTerm(read('.gitignore'), committedHashes()), false, 'a deny-list term in .gitignore');
  });
});
