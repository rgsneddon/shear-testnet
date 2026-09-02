import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  extraMintAllowed,
  JOIN_PROGRAM,
  JOIN_KIND_GENESIS,
  RESERVE_PROGRAM,
} from './asert.js';

const rootDir = join(dirname(fileURLToPath(import.meta.url)), '..');

describe('The Join is removed', () => {
  it('never extra-mints, including join-genesis', () => {
    assert.equal(extraMintAllowed(RESERVE_PROGRAM), true);
    assert.equal(extraMintAllowed(JOIN_PROGRAM), false);
    assert.equal(extraMintAllowed(JOIN_PROGRAM, { kind: JOIN_KIND_GENESIS }), false);
  });

  it('does not ship Join.sol or join_vault.js', () => {
    assert.equal(existsSync(join(rootDir, 'contracts/Join.sol')), false);
    assert.equal(existsSync(join(rootDir, 'crypto/join_vault.js')), false);
  });
});
