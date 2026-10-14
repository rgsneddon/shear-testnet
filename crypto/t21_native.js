/**
 * Bridge to the native T21 row prover (shear-fs1 `t21_prove`, feature t21-prove).
 *
 * The tool is stateless: one request per run, and it re-derives every row
 * secret from the build seed, so its replies are the bytes crypto/t21.js would
 * produce. buildT21Coinbase uses it when a binary is pinned and falls back to
 * the JS prover otherwise.
 *
 * The binary is SHEAR_T21_PROVE_BIN (default: the crate's release path) and is
 * used only when SHEAR_T21_PROVE_SHA256 pins it. A pinned path that does not
 * match is refused, not skipped. SHEAR_T21_PROVE_THREADS sets the thread count.
 */
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { H, asU8, pointBytes, scalarBytes } from './note.js';

const here = path.dirname(fileURLToPath(import.meta.url));
export const T21_PROVE_BIN_DEFAULT = path.join(here, 'native/vendor/monero-oxide-77788c3/target/release/t21_prove');
/** Largest reply read: 470 rows of about 11.5 KB and 7,485 share lines fit with room. */
export const T21_PROVE_MAX_REPLY = 256 << 20;

const HEX32 = /^[0-9a-f]{64}$/;

function fail(reason, extra = {}) {
  const err = new Error(reason);
  err.reason = reason;
  Object.assign(err, extra);
  return err;
}

/** A failure of the tool itself, not of the request: the caller may prove in JS instead. */
function engineFail(reason) {
  return fail(reason, { engine: true });
}

const hex = (b) => Buffer.from(asU8(b)).toString('hex');
const sc = (s) => scalarBytes(s).toString('hex');

/** sha256 of the binary, hex. */
export function t21ProveBinSha256(bin) {
  return createHash('sha256').update(fs.readFileSync(bin)).digest('hex');
}

/** A regular file, not writable by group or others, whose sha256 is `sha256`. Returns the real path. */
export function verifyT21ProveBin(bin, sha256) {
  if (!HEX32.test(String(sha256 || ''))) throw new Error('t21_prove_bin_unpinned');
  const real = fs.realpathSync(path.resolve(bin));
  const st = fs.statSync(real);
  if (!st.isFile()) throw new Error('t21_prove_bin_not_file');
  if (st.mode & 0o022) throw new Error('t21_prove_bin_writable');
  if (t21ProveBinSha256(real) !== sha256) throw new Error('t21_prove_bin_hash');
  return real;
}

function config(over = {}) {
  return {
    bin: over.bin ?? process.env.SHEAR_T21_PROVE_BIN ?? T21_PROVE_BIN_DEFAULT,
    sha256: over.sha256 ?? process.env.SHEAR_T21_PROVE_SHA256,
    threads: Number(over.threads ?? process.env.SHEAR_T21_PROVE_THREADS ?? 0),
  };
}

/** Whether a native prover would be used, and why not. Never throws. */
export function t21ProverInfo(over = {}) {
  const { bin, sha256 } = config(over);
  if (!sha256) return { native: false, reason: 'unpinned' };
  if (!bin || !fs.existsSync(bin)) return { native: false, reason: 'no_bin' };
  try {
    verifyT21ProveBin(bin, sha256);
    return { native: true, bin };
  } catch (err) {
    return { native: false, reason: err.message };
  }
}

function parseReply(stdout, status) {
  const lines = stdout.split('\n');
  if (lines[lines.length - 1] === '') lines.pop();
  const last = lines[lines.length - 1] || '';
  if (last.startsWith('error ')) {
    const [, reason, at] = last.split(' ');
    throw fail(`t21_native_${reason}`, { nativeReason: reason, index: at === '-' ? null : Number(at) });
  }
  if (status !== 0 || last !== 'ok') throw engineFail('t21_prove_engine_reply');
  return lines.slice(0, -1).map((l) => l.split(' '));
}

const buf = (h) => {
  if (!HEX32.test(h || '')) throw engineFail('t21_prove_engine_reply');
  return Buffer.from(h, 'hex');
};

/** Reply line `row <index> <n> <C> <P> <cw> <rhoK x3> <delK x3> <epV epD M x20>`. */
function committedOf(f, at) {
  if (f.length !== 1 + 2 + 3 + 6 + 60 || f[0] !== 'row' || Number(f[1]) !== at) throw engineFail('t21_prove_engine_reply');
  const p = f.slice(3).map(buf);
  const chunks = [];
  for (let j = 0; j < 20; j += 1) chunks.push({ epV: p[9 + 3 * j], epD: p[10 + 3 * j], Mpt: p[11 + 3 * j] });
  return { index: at, n: Number(f[2]), C: p[0], P: p[1], cw: p[2], rhoK: p.slice(3, 6), delK: p.slice(6, 9), chunks };
}

/** Reply line `row <index> ...`: the row's `ra.chunks` tail, `ra.agg`, `law` and `bp`. */
function provedOf(f, at, pubChunks) {
  if (f.length !== 2 + 80 + 9 + 2 + 27 || f[0] !== 'row' || Number(f[1]) !== at) throw engineFail('t21_prove_engine_reply');
  const p = f.slice(2).map(buf);
  const chunks = pubChunks.map((c, j) => ({
    epV: c.epV, epD: c.epD, Mpt: c.Mpt, bindR1: p[4 * j], bindR2: p[4 * j + 1], zT: p[4 * j + 2], zS: p[4 * j + 3],
  }));
  const a = p.slice(80, 89);
  const agg = { RC: a[0], RVv: a[1], RDv: a[2], RVr: a[3], RDr: a[4], zv: a[5], zr: a[6], ztv: a[7], ztr: a[8] };
  const law = { Rpt: p[89], z: p[90] };
  const b = p.slice(91);
  const bp = {
    A: b[0], S: b[1], T1: b[2], T2: b[3], taux: b[4], mu: b[5], that: b[6], L: b.slice(7, 16), R: b.slice(16, 25), a: b[25], b: b[26],
  };
  return { chunks, agg, law, bp };
}

/** The `commit` request text. */
export function commitRequest({ seed, magic, height, prevHash, W, rows }) {
  const head = ['commit', hex(pointBytes(H)), hex(seed), hex(Buffer.from(String(magic))) || '-', String(height),
    hex(prevHash) || '-', W.toString(), String(rows.length)].join(' ');
  const body = rows.map((r, i) => [i, r.noLeaf ? 1 : 0, r.v, r.Wi, r.rho, hex(r.B), hex(r.Y)].join(' '));
  return [head, ...body, ''].join('\n');
}

/** The `prove` request text. */
export function proveRequest({ seed, stmt, W, rate, rows, shares }) {
  const head = ['prove', hex(pointBytes(H)), hex(seed), hex(stmt), W.toString(), rate.toString(),
    String(rows.length), String(shares.length)].join(' ');
  const body = rows.map((r, i) => [i, r.n, r.v, r.Wi, r.rho, r.finEff, hex(r.Y), hex(r.lambda)].join(' '));
  const sh = shares.map((s) => [BigInt(s.w), hex(s.E), sc(s.ell), sc(s.beta)].join(' '));
  return [head, ...body, ...sh, ''].join('\n');
}

/**
 * The native prover, or null when none is pinned. Throws when a pinned path
 * is the wrong file. Each call runs the tool once.
 */
export function t21ProverEngine(over = {}) {
  const { bin, sha256, threads } = config(over);
  if (!sha256 || !bin || !fs.existsSync(bin)) return null;
  const real = verifyT21ProveBin(bin, sha256);
  const argv = threads > 0 ? ['--threads', String(Math.floor(threads))] : [];

  function run(text, extra = []) {
    const out = spawnSync(real, [...argv, ...extra], {
      input: text, maxBuffer: T21_PROVE_MAX_REPLY, encoding: 'utf8', stdio: ['pipe', 'pipe', 'inherit'],
    });
    if (out.error) throw engineFail('t21_prove_engine_exit');
    return out;
  }

  return {
    bin: real,
    /**
     * Phase one. `rows`: [{ noLeaf, v, Wi, rho, B, Y }] in vout index order.
     * Returns per row { index, n, C, P, cw, rhoK, delK, chunks }.
     */
    commit({ seed, magic, height, prevHash, W, rows }) {
      const out = run(commitRequest({ seed, magic, height, prevHash, W, rows }));
      const lines = parseReply(out.stdout, out.status);
      if (lines.length !== rows.length) throw engineFail('t21_prove_engine_reply');
      return lines.map(committedOf);
    },
    /**
     * Phase two and the tally. `rows`: [{ n, v, Wi, rho, finEff, Y, lambda, chunks }]
     * in index order, `chunks` the phase-one ciphertexts; `shares`: [{ w, E, ell, beta }].
     */
    prove({ seed, stmt, W, rate, rows, shares }) {
      const out = run(proveRequest({ seed, stmt, W, rate, rows, shares }));
      const lines = parseReply(out.stdout, out.status);
      if (lines.length !== rows.length + shares.length + 1) throw engineFail('t21_prove_engine_reply');
      const proved = rows.map((r, i) => provedOf(lines[i], i, r.chunks));
      const inv = lines.slice(rows.length, rows.length + shares.length).map((f) => {
        if (f.length !== 7 || f[0] !== 'inv') throw engineFail('t21_prove_engine_reply');
        const p = f.slice(1).map(buf);
        return { Cinv: p[0], proof: { Rp: p[1], Ra: p[2], zA: p[3], zDiff: p[4], zBlind: p[5] } };
      });
      const t = lines[lines.length - 1];
      if (t.length !== 6 || t[0] !== 'tally' || !/^\d{1,2}$/.test(t[1])) throw engineFail('t21_prove_engine_reply');
      const tally = {
        n: Number(t[1]), inv, balance: { Rpt: buf(t[2]), z: buf(t[3]) }, weight: { Rpt: buf(t[4]), z: buf(t[5]) },
      };
      return { proved, tally };
    },
    /** The tool's own timing run on synthetic rows: one line of text. */
    bench(rows, shares) {
      const out = run('', ['--bench', String(rows), String(shares)]);
      if (out.status !== 0) throw engineFail('t21_prove_engine_exit');
      return out.stdout.trim();
    },
  };
}
