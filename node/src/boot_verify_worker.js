/**
 * Boot-verify thread. stepLoaded runs here so the node event loop can
 * serve timers. Progress lines are posted; the parent writes stderr.
 *
 * verifyOpts is the full set the main thread passed to verifyLoadedChain.
 * This file does not keep its own list of load options. burialOf is rebuilt
 * from the integer tips the parent copied, because a function cannot cross.
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
    const opts = { ...(workerData.verifyOpts || {}) };
    const burialOf = burialOfFromTips(workerData.burialTips);
    if (burialOf) opts.burialOf = burialOf;
    opts.onBlock = ({ height, total, line }) => {
      parentPort.postMessage({ type: 'block', height, total, line });
    };
    const result = verifyLoadedChain(workerData.blocks, opts);
    parentPort.postMessage({ type: 'result', result });
  } catch (err) {
    parentPort.postMessage({ type: 'error', message: String(err?.message || err || 'boot_verify') });
  }
}

if (parentPort && workerData) run();
