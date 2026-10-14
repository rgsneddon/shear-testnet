/**
 * T21 prover timings. Builds and verifies a cb-v3 coinbase with N payout rows.
 *
 *   node scripts/t21_prove_bench.mjs [--rows 5,49,171] [--shares 2] [--js] [--verify]
 *
 * Uses the native prover when SHEAR_T21_PROVE_BIN and SHEAR_T21_PROVE_SHA256
 * are set (or the default release path is pinned), unless --js is given.
 * Rows past payeeCapLive() cannot be built through buildT21Coinbase, so
 * --raw N times the native commit and prove requests alone on N synthetic rows.
 */
import { performance } from 'node:perf_hooks';
import { buildT21Coinbase, minerShare, t21ShareNc, verifyT21Coinbase } from '../crypto/t21.js';
import { publicVoucher, voucherAt, voucherKeysOk } from '../crypto/t21_voucher.js';
import { W_HASH_MAX } from '../crypto/t21_params.js';
import { t21ProverEngine, t21ProverInfo } from '../crypto/t21_native.js';

const args = process.argv.slice(2);
const opt = (name, dflt) => {
  const at = args.indexOf(`--${name}`);
  return at >= 0 ? args[at + 1] : dflt;
};
const flag = (name) => args.includes(`--${name}`);
const rowsList = String(opt('rows', '5,49')).split(',').filter(Boolean).map(Number);
const perRow = Number(opt('shares', '2'));
const magic = 'shear-testnet-v12';
const prevHash = Buffer.alloc(32, 1);

const pool = [];
function vouchers(n) {
  for (let k = pool.length; pool.length < n; k += 1) {
    const v = voucherAt(Buffer.alloc(32, 0x40 + (k % 64)), Math.floor(k / 64));
    if (voucherKeysOk(publicVoucher(v))) pool.push(v);
  }
  return pool.slice(0, n);
}

function specFor(n) {
  const payees = vouchers(n).map((v, i) => ({
    voucher: publicVoucher(v),
    shares: Array.from({ length: perRow }, (_, k) => minerShare(v, 1000 + i * perRow + k)),
  }));
  return {
    S: 50_000_000_000n, cin: 7n, bps: 0, u: 3n, height: 11, magic, prevHash, payees,
    seed: Buffer.alloc(32, 5), dummySecret: Buffer.alloc(32, 9), payeeMax: n,
  };
}

const mode = flag('js') ? 'js' : (t21ProverInfo().native ? 'native' : 'js');
console.log(`prover=${mode} ${JSON.stringify(t21ProverInfo())} shares/row=${perRow}`);
for (const n of rowsList) {
  const spec = specFor(n);
  const t0 = performance.now();
  const built = buildT21Coinbase({ ...spec, prover: mode });
  const t1 = performance.now();
  const rows = built.tx.vout.length;
  let line = `rows=${rows} shares=${built.tx.t21.shares.length} build=${((t1 - t0) / 1000).toFixed(2)}s`;
  if (flag('verify')) {
    const tx = built.tx;
    const expect = {
      S: BigInt(tx.t21.S), cin: BigInt(tx.t21.cin), u: BigInt(tx.t21.u), height: tx.t21.height, magic, prevHash,
      shares: tx.t21.shares.map((s) => ({ nc: t21ShareNc(magic, s.E), units: BigInt(s.w) })),
      prevEs: new Set(), vaults: [], hashBudget: BigInt(tx.t21.u) * W_HASH_MAX,
    };
    const v0 = performance.now();
    const ok = verifyT21Coinbase({ tx, expect });
    line += ` verify=${((performance.now() - v0) / 1000).toFixed(2)}s ok=${ok.ok}${ok.ok ? '' : ` ${ok.reason}`}`;
  }
  console.log(line);
}

const raw = opt('raw', null);
if (raw) {
  const engine = t21ProverEngine();
  if (!engine) throw new Error('no native prover');
  for (const n of String(raw).split(',').map(Number)) console.log(engine.bench(n, perRow));
}
