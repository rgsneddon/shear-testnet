import { MAGIC_TESTNET } from '../../crypto/asert.js';
import { NODE_DISPLAY } from './product.js';

const TOPICS = ['run', 'env', 'rpc', 'solo', 'p2p', 'bootstrap', 'status'];

function sectionRun() {
  return [
    'Run:',
    '  node node/src/node.js                 start validator (P2P + loopback RPC)',
    '  node node/src/node.js --mode=p2p-sync P2P sidecar: owns :30303, no pool HTTP, no stratum',
    '  node node/src/node.js --solo          validator + thin local stratum 127.0.0.1:1111',
    '  npm run solo                          same as --solo (not the public pool)',
    '  node node/src/node.js --fast-sync     skip archival bodies (peers still verify PoW)',
    '  Default start never pulls a bootstrap. Empty datadir syncs height 1, 2, 3, … to the tip.',
    '  A datadir that already has blocks resumes from that tip and syncs to the network tip.',
    '  Optional: SHEAR_BOOTSTRAP=1 or --bootstrap=URL on an empty book installs boot.shear.digital once.',
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
    '  SHEAR_DATA          datadir. Windows %APPDATA%\\Shear\\testnet-v10 (Roaming). Unix ~/.shear/testnet-v10.',
    '                      Same path for Shear Sentinel v17 and Continuum 0.69.',
    '  SHEAR_NETWORK       shear-testnet-v10 (this book). shear-v1 waits for genesis.',
    '  SHEAR_P2P_PORT      default 30303',
    '  SHEAR_P2P_BIND      default 0.0.0.0',
    '  SHEAR_P2P_IPC       pool-to-sidecar localhost TCP (default 127.0.0.1:30313). Not a peer port.',
    '                      Empty SHEAR_SEEDS dials nobody. Unset keeps the hostname defaults.',
    '  SHEAR_RPC_PORT      default 18332',
    '  SHEAR_RPC_BIND      default 127.0.0.1 (loopback — do not bind RPC public)',
    '  SHEAR_SEEDS         comma host:port',
    '                      default p2p.shear.digital:30303, r2r.shear.digital:30303, b2b.shear.digital:30303',
    '  SHEAR_P2P_MAX_FRAME P2P JSON line cap (default 2 MiB)',
    '  SHEAR_MAX_PEERS     live peer cap (default 32)',
    '  SHEAR_FAST_SYNC     1 = skip archival bodies (not share PoW)',
    '  SHEAR_HTTP_FOLLOW   1 = verify blocks from the public node HTTPS when P2P has no taller peer',
    '  SHEAR_GETBLOCK_BATCH  in-flight IBD getblock window (default 16)',
    '  SHEAR_SOLO          1 = thin local stratum (same as --solo / npm run solo)',
    '  SHEAR_STRATUM       solo stratum port (default 1111)',
    '  SHEAR_STRATUM_BIND  solo stratum bind (default 127.0.0.1)',
    '  SHEARK_MINER        optional path to ShearK-Miner 2.8 if shearhash.node is missing',
    '  SHEAR_MAINNET_EMIT  do not set. Launch is not decided.',
    '  SHEAR_MAINNET_EMIT_CONFIRM  do not set.',
  ];
}

function sectionRpc() {
  return [
    'RPC (loopback JSON, GET or JSON-RPC):',
    '  GET /stats | /api/stats     height, hash, jroot, magic, fingerprint',
    '  GET /api/network | /network synced nodes, tip hash, proven round hashes. No dest, amount, or claimed hash rate',
    '  GET /header?height=N        one header',
    '  GET /headers?from=&to=      header window',
    '  GET /block?height=N         compact block',
    '  GET /blocks?from=&to=       compact window',
    '  GET /chaintips /reorgs /policy /jroot /fingerprint /fluxset',
    '  GET /notes /api/wallet/notes /api/wallet/balance /api/wallet/history',
    '  GET /api/oracle | /oracle   staking basket. Mint uses frozen epochBps. A stale basket does not move it.',
    '  GET /api/reserve?address=   one portal: staked, idle, vote, accrued. Public vote counts. No other dests.',
    '  POST /api/wallet/send | /queuetx',
    '',
    'Reserve lock, epoch vote, and withdraw are sealed transactions. This node applies them.',
    'The staking oracle is shear-reserve-oracle-v1. It cannot move the pot or the hash-bonus pile.',
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
    '       export SHEAR_NETWORK=shear-testnet-v10',
    '       export SHEAR_SEEDS=p2p.shear.digital:30303,r2r.shear.digital:30303,b2b.shear.digital:30303',
    '       export SHEAR_RPC_BIND=127.0.0.1',
    '       npm run solo',
    '     Bare node node/src/node.js is validator-only (no stratum).',
    '     npm run pool is the public-pool operator stack — not solo.',
    '  3. CLI (first-class) or Continuum 0.69:',
    '       dart run bin/shear.dart dest --rpc http://127.0.0.1:18332',
    '       dart run bin/shear.dart balance',
    '       dart run bin/shear.dart history',
    '  4. Status lines print height, hash, peers, want, ibd, hashBackend.',
    '     hashBackend=missing means shares will reject native_missing — build step 1.',
    '  Mining, --solo, and a self-pool need Shear Sentinel v17. A follow-only node may lag.',
    '  5. ./ShearK-Miner --selftest',
    '     ./ShearK-Miner --pool 127.0.0.1:1111 --user YOUR_SSA1.solo --threads 8',
    '',
    'Finder keeps the live epoch pot + hash bonus on Copy dest. No pool fee.',
    'The 1% in pool/src/pool.js THIS_POOL_DIRECT_FEE_DEST is the pool operator fee only. Solo does not charge it.',
    'Login is wallet/CLI Copy dest as ssa1.solo. .solo is only a worker name.',
    'Stuck mid-IBD (unsigned@N then prev): pull tip, rebuild native, SHEAR_GETBLOCK_BATCH=1,',
    'same-shell SHEAR_SEEDS. Do not wipe the datadir unless CoS says so.',
  ];
}

function sectionP2p() {
  return [
    'P2P:',
    '  Listen :30303. Seeds are hostnames only.',
    '  The public pool process does not bind :30303. Run --mode=p2p-sync beside it.',
    '  That sidecar verifies blocks and feeds them over SHEAR_P2P_IPC (127.0.0.1 only).',
    '  Fleet peers run --mode=p2p-sync (store + P2P + loopback RPC), not the pool.',
    '  Solo --solo still serves 127.0.0.1 stratum from this same entry.',
    '  IBD: ibd=true while want/pending/retryPrev/syncing is busy, a live peer height is above this tip, or HTTPS follow has a taller public tip (peers may still be 0).',
    '  p2p_ingest reason=merkle is a sealed-block mismatch — do not skip verify.',
    '  p2p_ingest reason=prev is a parent miss; the node retries. It is not a ban.',
    '  p2p_ingest reason=unsigned on a sealed compact block retries after a short TTL. It is not a permanent fail. Pull tip and rebuild native; do not wipe.',
    '  Do not wipe a mid-IBD datadir unless CoS says so after a fix.',
    '  Magic stays shear-testnet-v10. Do not start sheark-v4-afk.',
  ];
}

function sectionBootstrap() {
  return [
    'Bootstrap:',
    '  Default start does not pull or apply a snapshot. Sync is sequential from the local tip (genesis if empty).',
    '  Optional manual import: SHEAR_BOOTSTRAP=1 or --bootstrap=https://boot.shear.digital on an empty datadir.',
    '  latest.json + latest.bin from boot.shear.digital. Magic shear-testnet-v10. Empty datadir only.',
    '  A datadir that already holds chain.bin or chain.jsonl resumes from that tip.',
    '  SHEAR_FAST_SYNC=1 skips archival bodies on this node only.',
  ];
}

function sectionStatus() {
  return [
    'Status:',
    '  While running, the process prints JSON event=status and a one-line stderr summary:',
    '    height=  hash=  peers=  want=  ibd=  peerMaxHeight=  syncPeerHeight=  peerHash=  hashBackend=',
    '  --status reads the datadir and prints once (no P2P bind).',
    '  height is this node\'s tip, not a guessed network height.',
    '  want is outstanding getblock hashes. ibd=true while catching up (queues, syncing, or a live peer tip is ahead) — not merely when want is 0.',
    '  peerMaxHeight and peerHash are the tallest live peer tip. Seeds behind this node stay visible there; they are not a second chain tip.',
  ];
}

export function helpTopics() {
  return TOPICS.slice();
}

export function printHelp(topic) {
  const t = String(topic || '').replace(/^-+/, '').toLowerCase();
  const head = [
    `${NODE_DISPLAY} — validating full node (ADMITv2)`,
    `Book magic: ${MAGIC_TESTNET}`,
    '',
  ];
  const tail = [
    '',
    'RPC is loopback. Do not bind RPC to the public internet.',
    'Mainnet shear-v1 is not live. The public countdown is 30th October 2026 at 1400hrs UK time. That countdown is a display date and does not emit. SHEAR_NETWORK=shear-v1 prints clock_wait unless SHEAR_MAINNET_EMIT=1 and SHEAR_MAINNET_EMIT_CONFIRM=I_UNDERSTAND_SHEAR_MAINNET.',
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
