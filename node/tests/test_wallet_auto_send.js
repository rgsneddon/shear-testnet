import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  Q_EPOCH_BLOCKS,
  AUTO_SEND_DELAY_WEIGHTS,
  autoSendDelayEpochs,
  autoSendEpoch,
  drawHold,
  holdReady,
  queueAutomaticSend,
  manualSendAllowed,
} from '../src/wallet_auto_send.js';

const specPath = path.join(path.dirname(fileURLToPath(import.meta.url)), '../../docs/wallet-auto-send-delay.md');

function specWeights(text) {
  const match = text.match(/weights = \[([0-9, ]+)\]/);
  assert.ok(match);
  return match[1].split(',').map((s) => Number(s.trim()));
}

describe('wallet automatic-send delay', () => {
  it('draws every byte from the shared spec weights', () => {
    const text = readFileSync(specPath, 'utf8');
    const weights = specWeights(text);
    assert.match(text, /qEpochBlocks = 8/);
    assert.equal(Q_EPOCH_BLOCKS, 8);
    assert.deepEqual(AUTO_SEND_DELAY_WEIGHTS, weights);
    assert.equal(weights.reduce((a, b) => a + b, 0), 256);
    const counts = weights.map(() => 0);
    for (let b = 0; b < 256; b++) {
      const k = autoSendDelayEpochs(b);
      counts[k] += 1;
      const hold = drawHold({ sealedTip: 16, byte: b });
      assert.equal(hold.v, 1);
      assert.equal(hold.epochBase, autoSendEpoch(16));
      assert.equal(hold.epochs, k);
      assert.equal(hold.releaseEpoch, hold.epochBase + k);
      assert.equal(holdReady(hold, 16 + k * Q_EPOCH_BLOCKS), true);
      if (k > 0) assert.equal(holdReady(hold, 16 + k * Q_EPOCH_BLOCKS - 1), false);
    }
    assert.deepEqual(counts, weights);
  });

  it('applies the hold only to automatic sends and does not redraw it', () => {
    assert.equal(manualSendAllowed(), true);
    const first = queueAutomaticSend({ hold: null, sealedTip: 16, byte: 200 });
    assert.equal(first.hold.epochs, 5);
    assert.equal(first.ready, false);
    const again = queueAutomaticSend({ hold: first.hold, sealedTip: 16, byte: 0 });
    assert.equal(again.hold, first.hold);
    assert.equal(again.hold.epochs, 5);
    assert.equal(holdReady(again.hold, 16 + 5 * Q_EPOCH_BLOCKS), true);
  });

  it('keeps the same hold record across a restart', () => {
    const drawn = drawHold({ sealedTip: 24, byte: 200 });
    const stored = JSON.parse(JSON.stringify(drawn));
    const resumed = queueAutomaticSend({ hold: stored, sealedTip: 24, byte: 255 });
    assert.deepEqual(resumed.hold, drawn);
    assert.equal(resumed.ready, false);
    assert.equal(holdReady(stored, 24 + 5 * Q_EPOCH_BLOCKS), true);
    assert.equal(manualSendAllowed(), true);
  });
});
