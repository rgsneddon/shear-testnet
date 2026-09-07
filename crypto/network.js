/**
 * Network profiles. Magic isolates books. HRP is shared.
 * Do not merge shear-testnet-v2 and shear-v1.
 */
import {
  MAGIC_TESTNET,
  MAGIC_MAINNET,
  GENESIS_BITS,
  LIVE_MIN_BITS,
} from './asert.js';

export const MAINNET_GENESIS_MS = Date.parse('2026-09-11T20:00:00.000Z');

export const MAINNET_SEEDS = [
  'p2p.shear.digital:30303',
  '46.224.132.83:30303',
  '178.105.187.178:30303',
];

export const NETWORKS = {
  testnet: {
    id: 'testnet',
    magic: MAGIC_TESTNET,
    dataDirName: 'testnet-v2',
    seeds: ['pool.shear.digital:30303'],
    flySeed: 'https://pool.shear.digital',
    mainnet: false,
    genesisBits: GENESIS_BITS,
    liveMinBits: LIVE_MIN_BITS,
  },
  mainnet: {
    id: 'mainnet',
    magic: MAGIC_MAINNET,
    dataDirName: 'mainnet',
    seeds: MAINNET_SEEDS,
    flySeed: '',
    mainnet: true,
    genesisMs: MAINNET_GENESIS_MS,
    genesisBits: GENESIS_BITS,
    liveMinBits: LIVE_MIN_BITS,
  },
};

export function networkOf(name) {
  const n = String(name == null || name === '' ? (process.env.SHEAR_NETWORK || 'testnet') : name)
    .trim()
    .toLowerCase();
  if (n === 'mainnet' || n === 'shear-v1' || n === MAGIC_MAINNET) return NETWORKS.mainnet;
  return NETWORKS.testnet;
}

/** Envelope magic must match the local book. Missing magic is legacy testnet-only. */
export function acceptsMagic(localMagic, blockMagic) {
  const local = String(localMagic || '');
  const got = blockMagic == null || blockMagic === '' ? '' : String(blockMagic);
  if (local === MAGIC_MAINNET) return got === MAGIC_MAINNET;
  if (!got) return local === MAGIC_TESTNET;
  return got === local;
}
