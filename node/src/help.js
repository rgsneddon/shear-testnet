import { MAGIC_TESTNET, PRODUCT_VERSION } from '../../crypto/asert.js';

const TOPICS = ['run', 'env', 'rpc', 'solo', 'p2p', 'bootstrap', 'status'];

function sectionRun() {
  return [
    'Run:',
    '  node node/src/node.js                 start validator (P2P + loopback RPC)',
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
    '  SHEARK_MINER        optional path to ShearK-Miner 2.4 if shearhash.node is missing',
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
    'Solo (your node finds the block):',
    '  1. Build RandomX + native on THIS box (never copy Darwin .node onto Linux):',
    '       cmake -S crypto/randomx -B crypto/randomx/build -DARCH=native',
    '       cmake --build crypto/randomx/build -j"$(nproc)"',
    '       make -C crypto/native',
    '  2. npm run pool     (stratum :1111 + validating node + optional P2P)',
    '     or node node/src/node.js   (validator only, no stratum)',
    '  3. Status lines print height, hash, peers, want, ibd, hashBackend.',
    '     hashBackend=missing means shares will reject native_missing — build step 1.',
    '  4. ./ShearK-Miner --selftest',
    '     ./ShearK-Miner --pool 127.0.0.1:1111 --user YOUR_SSA1.solo --threads 8',
    '',
    'Login is wallet Copy dest as ssa1.worker. .solo is only a worker name.',
  ];
}

function sectionP2p() {
  return [
    'P2P:',
    '  Listen :30303. Seeds are hostnames only.',
    '  IBD: status.want > 0 means this node is still fetching blocks (ibd=true).',
    '  p2p_ingest reason=merkle is a sealed-block mismatch — do not skip verify.',
    '  p2p_ingest reason=prev is a parent miss; the node retries.',
    '  Wipe every datadir together if you recut; start P2P boxes, then the pool.',
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
    '  want is outstanding getblock hashes. ibd=true until want is 0.',
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
