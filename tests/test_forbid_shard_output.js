// Shard 15 greps the checkout. full-suite.yml writes shard.txt and tees
// shard.tap there, and test_brand.js prints "GNFP" into that tap.
import test from 'node:test';
import assert from 'node:assert/strict';
import { foreignGrepArgs, keepForeignLine } from './foreign_scan.js';

test('shard.tap and shard.txt are not foreign-name hits', () => {
  const tap = './shard.tap:12:pages use Segoe UI like the GNFP sites, not Nevia or Urema';
  const list = './shard.txt:1:pool/tests/test_brand.js';
  assert.equal(keepForeignLine(tap), false, 'shard.tap');
  assert.equal(keepForeignLine(list), false, 'shard.txt');
  assert.equal(keepForeignLine('shard.tap:1:GNFP'), false, 'basename shard.tap');
  assert.equal(keepForeignLine('shard.txt:1:Bitcoin'), false, 'basename shard.txt');
  assert.equal(keepForeignLine('./pool/public/index.html:3:GNFP'), true, 'a shipped hit stays');
  assert.equal(keepForeignLine('./pool/tests/test_brand.js:4:GNFP'), false, 'tests stay excluded');
  const args = foreignGrepArgs();
  assert.ok(args.includes('--exclude=shard.tap'), 'grep skips shard.tap');
  assert.ok(args.includes('--exclude=shard.txt'), 'grep skips shard.txt');
});
