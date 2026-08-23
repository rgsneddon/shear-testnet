#!/usr/bin/env node
import { MAGIC_TESTNET, GENESIS_BITS } from '../../crypto/asert.js';
import { CLIENT, ALGO, HEADER_LEN } from '../../crypto/shear_hash.js';
import { RESERVE_PROGRAM } from '../../crypto/asert.js';
import { extraMintAllowed } from '../../crypto/mint.js';

const VERSION = '0.1.0';

export function printConfig() {
  return {
    name: 'shear-node',
    version: VERSION,
    magic: MAGIC_TESTNET,
    client: CLIENT,
    algorithm: ALGO,
    headerBytes: HEADER_LEN,
    genesisBits: GENESIS_BITS,
    p2p: 30303,
    reserveProgram: RESERVE_PROGRAM,
    extraMintOnlyReserve: extraMintAllowed(RESERVE_PROGRAM),
    mainnet: false,
  };
}

if (process.argv.includes('--print-config')) {
  console.log(JSON.stringify(printConfig()));
}
