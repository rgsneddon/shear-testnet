/**
 * Stage 0. An honest-looking byte-3 flow spend is not accepted.
 * The verifier is not called. The prover in admit.js is not invoked here.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { verifyFlowAdmitV3, flowProofVerifyCount, resetFlowProofVerifies, v12FlowVersionRejected } from '../../crypto/admit_v3.js';

function byte3Send(id) {
  const blob = Buffer.alloc(129, 7);
  blob[0] = 3;
  return {
    id,
    kind: 'send',
    anchor: 8,
    vin: [{ commit: Buffer.alloc(32, 4) }],
    vout: [{ kind: 'send', nanos: 1 }, { kind: 'dummy', nanos: 0 }],
    admit_proof: {
      v: 3,
      blob,
      spendTag: blob.subarray(1, 33),
      cTilde: Buffer.alloc(32, 4),
    },
  };
}

describe('v12 honest flow spend', () => {
  it('does not accept a byte-3 spend and does not call the verifier', () => {
    resetFlowProofVerifies();
    const tx = byte3Send('gated-send');
    const version = v12FlowVersionRejected(tx);
    assert.equal(version.ok, false);
    assert.equal(version.reason, 'send_unavailable');
    assert.equal(version.state, 'sends disabled');
    const proved = verifyFlowAdmitV3(tx, { height: 17 });
    assert.equal(proved.reason, 'send_unavailable');
    assert.equal(flowProofVerifyCount(), 0);
  });
});
