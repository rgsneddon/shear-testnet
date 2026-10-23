/**
 * Full supply audit for a block list that has no consensus supply state.
 * The parent posts one block per turn. This thread verifies. The pool
 * event loop does not. The start message carries the store magic. A missing
 * magic throws. This thread does not substitute the v12 clock.
 */
import { parentPort } from 'node:worker_threads';
import { auditCirculatingSupply } from './supply.js';

const jobs = new Map();

parentPort.on('message', (msg) => {
  const id = msg?.id;
  try {
    if (!id) return;
    if (msg.type === 'start') {
      const length = Number(msg.length) || 0;
      jobs.set(id, { blocks: new Array(length), length, magic: msg.magic });
      return;
    }
    if (msg.type === 'block') {
      const job = jobs.get(id);
      if (!job) return;
      job.blocks[msg.index] = msg.block;
      return;
    }
    if (msg.type === 'end') {
      const job = jobs.get(id);
      jobs.delete(id);
      const audit = auditCirculatingSupply(job?.blocks || [], { magic: job?.magic });
      parentPort.postMessage({ id, audit });
    }
  } catch (err) {
    jobs.delete(id);
    parentPort.postMessage({ id, error: String(err?.message || err || 'audit_worker') });
  }
});
