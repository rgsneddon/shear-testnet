// R41 (Russell, 28 Oct): huge pages, large pages and similar device settings
// are the user's choice, documented in the README as optional. ShearK never
// sets them itself. This guard fails if any miner or RandomX code path
// writes a sysctl or /proc/sys, reserves hugetlb pages, writes an MSR,
// changes a governor or power plan, or grants itself a Windows right.
//
// One call is allowed and pinned: RandomX's virtual_memory.c asks
// AdjustTokenPrivileges to *enable* SeLockMemoryPrivilege in its own token
// before a large-page allocation. That only switches on a right the user
// already holds; it cannot grant one (granting needs LsaAddAccountRights,
// which nothing here calls), and without the right the allocation falls back
// to normal pages with a message.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..', '..');

function sources() {
  const dirs = ['sheark-miner/src', 'sheark-miner/bench', 'crypto/randomx/src', 'crypto/native'];
  const out = [];
  for (const d of dirs) {
    const abs = path.join(root, d);
    if (!fs.existsSync(abs)) continue;
    for (const name of fs.readdirSync(abs)) {
      if (!/\.(c|cpp|h|hpp|S|sh|mjs|js)$/.test(name)) continue;
      out.push(path.join(d, name));
    }
  }
  return out;
}

const FORBIDDEN = [
  [/LsaAddAccountRights|LsaOpenPolicy/, 'grants a Windows account right'],
  [/sysctl\s+-w|sysctlbyname\([^)]*,[^)]*,[^)]*,\s*[^0N][^)]*\)/, 'writes a sysctl'],
  [/\/proc\/sys\/[^"'\s]*["']\s*,\s*["'][wa]/, 'writes /proc/sys'],
  [/nr_hugepages[^\n]*(fopen|open)\([^)]*["'][wa]|(fopen|open)\([^)]*nr_hugepages[^)]*["'][wa]/, 'reserves hugetlb pages'],
  [/\/dev\/cpu\/[^"']*msr[^\n]*O_(WRONLY|RDWR)|wrmsr/, 'writes an MSR'],
  [/scaling_governor[^\n]*["'][wa]|powercfg\s+\/s/i, 'changes the governor or power plan'],
];

describe('ShearK never changes a system setting (R41)', () => {
  it('no miner, bench or RandomX source writes sysctl, hugetlb, MSR, governor or Windows rights', () => {
    for (const rel of sources()) {
      const text = fs.readFileSync(path.join(root, rel), 'utf8');
      for (const [re, what] of FORBIDDEN) assert.doesNotMatch(text, re, `${rel} ${what}`);
    }
  });

  it('the one privilege call only enables SeLockMemoryPrivilege, and is pinned', () => {
    const hits = [];
    for (const rel of sources()) {
      const text = fs.readFileSync(path.join(root, rel), 'utf8');
      if (/AdjustTokenPrivileges\s*\(/.test(text)) hits.push(rel);
    }
    assert.deepEqual(hits, ['crypto/randomx/src/virtual_memory.c']);
    const vm = fs.readFileSync(path.join(root, 'crypto/randomx/src/virtual_memory.c'), 'utf8');
    assert.match(vm, /setPrivilege\("SeLockMemoryPrivilege", 1, &errfunc\)/);
    assert.equal((vm.match(/setPrivilege\(/g) || []).length, 2, 'one definition, one call');
  });

  it('the README documents the settings as optional, for the user to choose', () => {
    const md = fs.readFileSync(path.join(root, 'sheark-miner/README.md'), 'utf8');
    assert.match(md, /vm\.nr_hugepages/);
    assert.match(md, /Lock pages in memory/);
    assert.match(md, /never sets? (these|them)/i);
  });
});
