/**
 * Boot-verify thread. stepLoaded runs here so the node event loop can
 * serve timers. Progress lines are posted; the parent writes stderr.
 */
import { parentPort, workerData } from 'node:worker_threads';
import { verifyLoadedChain } from './chain.js';

function burialOfFromTips(tips) {
  if (!Array.isArray(tips)) return null;
  return (block) => {
    const height = Number(block?.height);
    if (!Number.isInteger(height) || height < 1 || height > tips.length) return null;
    const tip = tips[height - 1];
    return Number.isInteger(tip) ? tip : null;
  };
}

function run() {
  try {
    const tips = workerData.burialTips;
    const opts = {
      trustStoredHash: workerData.trustStoredHash === true,
      nowMs: workerData.nowMs,
      quiet: workerData.quiet === true,
      burialOf: burialOfFromTips(tips),
      onBlock: ({ height, total, line }) => {
        parentPort.postMessage({ type: 'block', height, total, line });
      },
    };
    if ('trustShareWork' in workerData) opts.trustShareWork = workerData.trustShareWork;
    if ('genesisHash' in workerData) opts.genesisHash = workerData.genesisHash;
    if ('checkpoint' in workerData) opts.checkpoint = workerData.checkpoint;
    if ('fromIndex' in workerData) opts.fromIndex = workerData.fromIndex;
    if ('prior' in workerData) opts.prior = workerData.prior;
    if ('reorgHaltDepth' in workerData) opts.reorgHaltDepth = workerData.reorgHaltDepth;
    const result = verifyLoadedChain(workerData.blocks, opts);
    parentPort.postMessage({ type: 'result', result });
  } catch (err) {
    parentPort.postMessage({ type: 'error', message: String(err?.message || err || 'boot_verify') });
  }
}

if (parentPort && workerData) run();
