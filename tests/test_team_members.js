import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// team.shear.digital lists every Shear lane as a member card. Russell (30 Oct)
// added Host Meticulo and asked for any missing members; Supply Auditor was the gap.

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const page = fs.readFileSync(path.join(root, 'team/index.html'), 'utf8');

const LANES = [
  'Codebase Auditor', 'Protocol Assailant', 'Attack Cartographer', 'Privacy Auditor',
  'Wallet Hardening', 'Vault Security', 'Pool Share Auditor', 'Mining Economics',
  'Pool Op Wallet', 'Supply Auditor', 'Website Analyst', 'FUX', 'Host Meticulo',
];
const NEW = [
  { lane: 'Supply Auditor', name: 'Audra Tally', file: 'supply-auditor.jpg' },
  { lane: 'Host Meticulo', name: 'Matteo Ward', file: 'host-meticulo.jpg' },
];

function cards() {
  return [...page.matchAll(/<article class="card[^"]*">([\s\S]*?)<\/article>/g)].map((m) => {
    const b = m[1];
    const pick = (re) => (b.match(re) || [])[1];
    return {
      name: (pick(/<h3>([\s\S]*?)<\/h3>/) || '').replace(/<[^>]+>/g, '').trim(),
      aka: pick(/aka <strong>([^<]+)<\/strong>/),
      role: pick(/class="role">([^<]+)</),
      src: pick(/<img class="avatar[^"]*" src="([^"]+)"/),
      alt: pick(/<img [^>]*alt="([^"]*)"/),
      bio: pick(/class="bio">([\s\S]*?)<\/p>/),
    };
  });
}

function jpegSize(buf) {
  assert.equal(buf.readUInt16BE(0), 0xffd8, 'not a JPEG');
  let i = 2;
  while (i < buf.length) {
    const marker = buf.readUInt16BE(i);
    const len = buf.readUInt16BE(i + 2);
    if (marker >= 0xffc0 && marker <= 0xffc3) return { h: buf.readUInt16BE(i + 5), w: buf.readUInt16BE(i + 7) };
    i += 2 + len;
  }
  throw new Error('no SOF');
}

describe('team page: one card per lane', () => {
  const all = cards();

  it("drops the 'A first for Shear' Coding Team line (Russell, 30 Oct)", () => {
    assert.doesNotMatch(page, /A first for Shear/);
  });

  it('Chief of Staff (Corin Sable) leads as CTO', () => {
    const cos = all.find((c) => c.name === 'Corin Sable');
    assert.ok(cos, 'no Corin Sable card');
    assert.equal(cos.role, 'CTO');
  });

  for (const lane of LANES) {
    it(`${lane} has exactly one card`, () => {
      assert.equal(all.filter((c) => c.aka === lane).length, 1, `${lane}: card count`);
    });
  }

  for (const n of NEW) {
    it(`${n.lane} card: name, alt text, portrait, copy`, () => {
      const c = all.find((x) => x.aka === n.lane);
      assert.ok(c, `${n.lane}: no card`);
      assert.equal(c.name, n.name);
      assert.equal(c.alt, n.name, 'alt text is the member name');
      assert.equal(c.src, `avatars/${n.file}`);
      assert.match(c.role, /^Coding Assistant · /);
      assert.ok(c.bio && c.bio.length > 20, 'has a bio');
      assert.doesNotMatch(`${c.role} ${c.bio}`, /\b(first|only|anonym\w*)\b/i, 'no first/only/anonymity claims');
      const abs = path.join(root, 'team', c.src);
      assert.ok(fs.existsSync(abs), `${c.src} missing`);
      assert.deepEqual(jpegSize(fs.readFileSync(abs)), { w: 1280, h: 720 }, 'same 1280x720 as the other portraits');
    });
  }
});
