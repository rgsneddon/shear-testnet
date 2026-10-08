import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { encodeDest } from '../../crypto/address.js';
import { MAGIC_TESTNET, MAGIC_TESTNET_V12 } from '../../crypto/asert.js';
import { reservePinOk } from '../../crypto/reserve_evm.js';
import { createRpc } from '../src/rpc.js';

function destMiner() {
  return encodeDest(Buffer.alloc(20, 3));
}

function stubStore(pinOk) {
  const calls = { template: 0, submit: 0 };
  return {
    calls,
    reservePinOk: () => pinOk,
    template() {
      calls.template += 1;
      return {
        tpl: { header: Buffer.alloc(80, 1), bits: 1, height: 1 },
        job: { jobId: 'job-1' },
      };
    },
    submitHeader() {
      calls.submit += 1;
      return { ok: true, height: 1 };
    },
  };
}

describe('reserve pin gates mining', () => {
  it('the live magic is in the pinned bytecode, and a stranger magic is not', () => {
    assert.equal(MAGIC_TESTNET, MAGIC_TESTNET_V12);
    assert.equal(reservePinOk(), true);
    assert.equal(reservePinOk('shear-testnet-v11'), true);
    assert.equal(reservePinOk('shear-testnet-v9'), true);
    assert.equal(reservePinOk('shear-testnet-not-a-book'), false);
    assert.equal(reservePinOk(''), false);
  });

  it('gettemplate and submitblock refuse when the pin misses, and run when it matches', () => {
    const dest = destMiner();
    const blocked = stubStore(false);
    const rpcOff = createRpc({ store: blocked, port: 0, host: '127.0.0.1' });
    const tplOff = rpcOff.dispatch('gettemplate', { miner: dest });
    const subOff = rpcOff.dispatch('submitblock', { jobId: 'job-1', nonce: '1', miner: dest });
    assert.equal(tplOff.ok, false);
    assert.equal(tplOff.reason, 'reserve_deploy');
    assert.equal(subOff.ok, false);
    assert.equal(subOff.reason, 'reserve_deploy');
    assert.equal(blocked.calls.template, 0);
    assert.equal(blocked.calls.submit, 0);

    const open = stubStore(true);
    const rpcOn = createRpc({ store: open, port: 0, host: '127.0.0.1' });
    const tplOn = rpcOn.dispatch('gettemplate', { miner: dest });
    const subOn = rpcOn.dispatch('submitblock', { jobId: 'job-1', nonce: '1', miner: dest });
    assert.equal(tplOn.ok, true, tplOn.reason);
    assert.equal(tplOn.magic, MAGIC_TESTNET);
    assert.ok(tplOn.header);
    assert.equal(subOn.ok, true);
    assert.equal(open.calls.template, 1);
    assert.equal(open.calls.submit, 1);
  });

  it('a live store with no override uses the bytecode pin', () => {
    const dest = destMiner();
    const calls = { template: 0 };
    const store = {
      template() {
        calls.template += 1;
        return {
          tpl: { header: Buffer.alloc(80, 2), bits: 1, height: 1 },
          job: { jobId: 'job-live' },
        };
      },
    };
    const rpc = createRpc({ store, port: 0, host: '127.0.0.1' });
    const got = rpc.dispatch('gettemplate', { miner: dest });
    assert.equal(got.ok, true, got.reason);
    assert.equal(got.magic, 'shear-testnet-v12');
    assert.equal(calls.template, 1);
  });
});
