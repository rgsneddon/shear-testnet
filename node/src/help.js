import { MAGIC_TESTNET, PRODUCT_VERSION } from '../../crypto/asert.js';

const TOPICS = ['run', 'env', 'rpc', 'solo', 'p2p', 'bootstrap', 'status'];

function sectionRun() {
  return [
    'Run:',
    '  node node/src/node.js                 start validator (P2P + loopback RPC)',
    '  node node/src/node.js --solo          validator + thin local stratum 127.0.0.1:1111',
    '  npm run solo                          same as --solo (not the public pool)',
    '  node node/src/node.js --fast-sync     skip archival bodies (peers still verify PoW)',
    '  node node/src/node.js --bootstrap=PATH|URL',
    '  node node/src/node.js --status        print height/hash/jroot/peers from datadir and exit',
    '  node node/src/node.js --print-config  JSON pin (magic, admit, mainnet=false)',
    '  node node/src/node.js --help | -h | help [topic]',
    '',
    `Topics: ${TOPICS.join(', ')}`,
    '  node node/src/node.js help rpc',
  ];
}

function sectionEnv() {
  return [
    'Env:',
    '  SHEAR_DATA          datadir (default ~/.shear/testnet-v4)',
    '  SHEAR_NETWORK       shear-testnet-v4 (this book). shear-v1 waits for genesis.',
    '  SHEAR_P2P_PORT      default 30303',
    '  SHEAR_P2P_BIND      default 0.0.0.0',
    '  SHEAR_RPC_PORT      default 18332',
    '  SHEAR_RPC_BIND      default 127.0.0.1 (loopback — do not bind RPC public)',
    '  SHEAR_SEEDS         comma host:port',
    '                      default p2p.shear.digital:30303, r2r.shear.digital:30303, b2b.shear.digital:30303',
    '  SHEAR_P2P_MAX_FRAME P2P JSON line cap (default 2 MiB)',
    '  SHEAR_MAX_PEERS     live peer cap (default 32)',
    '  SHEAR_FAST_SYNC     1 = skip archival bodies (not share PoW)',
    '  SHEAR_GETBLOCK_BATCH  in-flight IBD getblock window (default 16)',
    '  SHEAR_SOLO          1 = thin local stratum (same as --solo / npm run solo)',
    '  SHEAR_STRATUM       solo stratum port (default 1111)',
    '  SHEAR_STRATUM_BIND  solo stratum bind (default 127.0.0.1)',
    '  SHEARK_MINER        optional path to ShearK-Miner 2.5 if shearhash.node is missing',
    '  SHEAR_MAINNET_EMIT  do not set. Launch is not decided.',
    '  SHEAR_MAINNET_EMIT_CONFIRM  do not set.',
  ];
}

function sectionRpc() {
  return [
    'RPC (loopback JSON, GET or JSON-RPC):',
    '  GET /stats | /api/stats     height, hash, jroot, magic, fingerprint',
    '  GET /header?height=N        one header',
    '  GET /headers?from=&to=      header window',
    '  GET /block?height=N         compact block',
    '  GET /blocks?from=&to=       compact window',
    '  GET /chaintips /reorgs /policy /jroot /fingerprint /fluxset',
    '  GET /notes /api/wallet/notes /api/wallet/balance /api/wallet/history',
    '  POST /api/wallet/send | /queuetx',
    '',
    'Do not bind RPC to the public internet.',
  ];
}

function sectionSolo() {
  return [
    'Solo (your node finds the block — no full pool):',
    '  1. Build RandomX + native on THIS box (never copy Darwin .node onto Linux):',
    '       cmake -S crypto/randomx -B crypto/randomx/build -DARCH=native',
    '       cmake --build crypto/randomx/build -j"$(nproc)"',
    '       make -C crypto/native',
    '  2. Validating node + thin local stratum (NOT npm run pool):',
    '       export SHEAR_NETWORK=shear-testnet-v4',
    '       export SHEAR_SEEDS=p2p.shear.digital:30303,r2r.shear.digital:30303,b2b.shear.digital:30303',
    '       export SHEAR_RPC_BIND=127.0.0.1',
    '       npm run solo',
    '     Bare node node/src/node.js is validator-only (no stratum).',
    '     npm run pool is the public-pool operator stack — not solo.',
    '  3. CLI (first-class) or Continuum 0.43:',
    '       dart run bin/shear.dart dest --rpc http://127.0.0.1:18332',
    '       dart run bin/shear.dart balance',
    '       dart run bin/shear.dart history',
    '  4. Status lines print height, hash, peers, want, ibd, hashBackend.',
    '     hashBackend=missing means shares will reject native_missing — build step 1.',
    '  5. ./ShearK-Miner --selftest',
    '     ./ShearK-Miner --pool 127.0.0.1:1111 --user YOUR_SSA1.solo --threads 8',
    '',
    'Finder keeps the live epoch pot + hash bonus on Copy dest. No pool fee.',
    'Login is wallet/CLI Copy dest as ssa1.solo. .solo is only a worker name.',
    'Stuck mid-IBD (unsigned@N then prev): pull tip, rebuild native, SHEAR_GETBLOCK_BATCH=1,',
    'same-shell SHEAR_SEEDS. Do not wipe the datadir unless CoS says so.',
  ];
}

function sectionP2p() {
  return [
    'P2P:',
    '  Listen :30303. Seeds are hostnames only.',
    '  IBD: ibd=true while want/pending/retryPrev/syncing is busy, or a live peer height is above this tip.',
    '  p2p_ingest reason=merkle is a sealed-block mismatch — do not skip verify.',
    '  p2p_ingest reason=prev is a parent miss; the node retries. It is not a ban.',
    '  p2p_ingest reason=unsigned on a sealed compact block is a node bug — pull tip, rebuild native.',
    '  Do not wipe a mid-IBD datadir unless CoS says so after a fix.',
    '  Magic stays shear-testnet-v4. Do not start sheark-v4-afk.',
  ];
}

function sectionBootstrap() {
  return [
    'Bootstrap:',
    '  node node/src/node.js --bootstrap=/path/or/url',
    '  Latest-only prune snapshot. Default IBD stays full archival.',
    '  SHEAR_FAST_SYNC=1 skips archival bodies on this node only.',
  ];
}

function sectionStatus() {
  return [
    'Status:',
    '  While running, the process prints JSON event=status and a one-line stderr summary:',
    '    height=  hash=  peers=  want=  ibd=  hashBackend=',
    '  --status reads the datadir and prints once (no P2P bind).',
    '  height is this node\'s tip, not a guessed network height.',
    '  want is outstanding getblock hashes. ibd=true while catching up (queues, syncing, or a live peer tip is ahead) — not merely when want is 0.',
  ];
}

export function helpTopics() {
  return TOPICS.slice();
}

export function printHelp(topic) {
  const t = String(topic || '').replace(/^-+/, '').toLowerCase();
  const head = [
    `shear-node ${PRODUCT_VERSION} — validating full node (ADMITv2)`,
    `Book magic: ${MAGIC_TESTNET}`,
    '',
  ];
  const tail = [
    '',
    'RPC is loopback. Do not bind RPC to the public internet.',
    'Mainnet shear-v1 is not live and is not yet scheduled. SHEAR_NETWORK=shear-v1 prints clock_wait unless SHEAR_MAINNET_EMIT=1 and SHEAR_MAINNET_EMIT_CONFIRM=I_UNDERSTAND_SHEAR_MAINNET.',
    'Build native addons on this box: cmake randomx, then make -C crypto/native',
  ];
  const body = {
    run: sectionRun(),
    env: sectionEnv(),
    rpc: sectionRpc(),
    solo: sectionSolo(),
    p2p: sectionP2p(),
    bootstrap: sectionBootstrap(),
    status: sectionStatus(),
  };
  if (t && body[t]) {
    return [...head, ...body[t], ...tail].join('\n');
  }
  return [
    ...head,
    ...sectionRun(),
    '',
    ...sectionEnv(),
    '',
    ...sectionRpc(),
    '',
    ...sectionSolo(),
    '',
    ...sectionP2p(),
    '',
    ...sectionBootstrap(),
    '',
    ...sectionStatus(),
    ...tail,
  ].join('\n');
}
