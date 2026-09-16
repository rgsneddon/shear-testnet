/**
 * Native ADMITv2 1k/10k/100k bench. Writes JSON lines to stdout.
 * Membership verify is jroot-only (no full-J recompute).
 */
import { nativeBench, nativeLoaded } from './native_admit.js';

if (!nativeLoaded()) {
  console.error('shearadmit.node not loaded');
  process.exit(2);
}

const sizes = (process.argv.slice(2).map((x) => Number(x)).filter((n) => n > 0));
const ns = sizes.length ? sizes : [1_000, 10_000, 100_000];
for (const n of ns) {
  const t0 = Date.now();
  const got = nativeBench(n);
  const wallMs = Date.now() - t0;
  if (!got) {
    console.log(JSON.stringify({ ok: false, n, wallMs }));
    process.exit(1);
  }
  console.log(JSON.stringify({
    ok: true,
    n,
    proveMs: got.proveUs / 1000,
    verifyMs: got.verifyUs / 1000,
    proofLen: got.proofLen,
    wallMs,
    admit: 'ADMITv2',
  }));
}
