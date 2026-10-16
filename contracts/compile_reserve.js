/**
 * Reserve.sol's allowlist and contracts/Reserve.json are generated from
 * crypto/reserve_books.js. Run this file to rewrite both. Importing it does not write.
 */
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { RESERVE_BOOKS, RESERVE_PROGRAM_ID } from '../crypto/reserve_books.js';
import { GENESIS_BPS } from '../crypto/reserve_oracle.js';

const require = createRequire(import.meta.url);
const solc = require('solc');

const dir = path.dirname(fileURLToPath(import.meta.url));
const srcPath = path.join(dir, 'Reserve.sol');
const jsonPath = path.join(dir, 'Reserve.json');

const CONST_RE = / {4}bytes32 public constant SHEAR_TESTNET = keccak256\(bytes\("[^"]+"\)\);(?:\r?\n {4}bytes32 public constant [A-Z0-9_]+ = keccak256\(bytes\("[^"]+"\)\);)+/;
const ALLOW_RE = / {8}if \(magic != SHEAR_TESTNET && magic != [\s\S]*?\) revert NotShear\(\);/;

export function renderReserveConstants(books = RESERVE_BOOKS, newline = '\n') {
  const lines = books.map((b) =>
    `    bytes32 public constant ${b.sol} = keccak256(bytes("${b.magic}"));`);
  lines.push(`    bytes32 public constant PROGRAM_ID = keccak256(bytes("${RESERVE_PROGRAM_ID}"));`);
  return lines.join(newline);
}

export function renderReserveAllow(books = RESERVE_BOOKS) {
  const cmp = books.map((b) => `magic != ${b.sol}`).join(' && ');
  return `        if (${cmp}) revert NotShear();`;
}

export function reserveSolRegions(source) {
  const constants = source.match(CONST_RE);
  const allow = source.match(ALLOW_RE);
  if (!constants || !allow) throw new Error('Reserve.sol magic regions missing');
  return { constants: constants[0], allow: allow[0] };
}

function assertNoCr(source) {
  if (String(source).includes('\r')) {
    throw new Error('Reserve.sol source contains a CR byte');
  }
}

/** Splice the book list into a Reserve.sol source. Does not write. */
export function applyReserveBooks(source, books = RESERVE_BOOKS) {
  assertNoCr(source);
  const regions = reserveSolRegions(source);
  const constants = renderReserveConstants(books);
  const allow = renderReserveAllow(books);
  if (!source.includes(regions.constants) || !source.includes(regions.allow)) {
    throw new Error('Reserve.sol magic regions missing');
  }
  const withBooks = source.replace(regions.constants, constants).replace(regions.allow, allow);
  const genesis = `uint256 public constant GENESIS_BPS = ${GENESIS_BPS};`;
  if (!withBooks.includes('uint256 public constant GENESIS_BPS = ')) {
    throw new Error('Reserve.sol GENESIS_BPS constant missing');
  }
  return withBooks.replace(/uint256 public constant GENESIS_BPS = \d+;/, genesis);
}

export function compileReserveSource(source) {
  assertNoCr(source);
  const input = {
    language: 'Solidity',
    sources: { 'Reserve.sol': { content: source } },
    settings: {
      optimizer: { enabled: true, runs: 200 },
      viaIR: true,
      evmVersion: 'shanghai',
      outputSelection: { '*': { '*': ['abi', 'evm.bytecode.object', 'evm.deployedBytecode.object'] } },
    },
  };
  const out = JSON.parse(solc.compile(JSON.stringify(input)));
  const errors = (out.errors || []).filter((e) => e.severity === 'error');
  if (errors.length) {
    const msg = errors.map((e) => e.formattedMessage || e.message).join('\n');
    throw new Error(msg);
  }
  const art = out.contracts['Reserve.sol'].Reserve;
  return {
    abi: art.abi,
    bytecode: String(art.evm.bytecode.object).toLowerCase(),
    deployedBytecode: String(art.evm.deployedBytecode.object).toLowerCase(),
  };
}

function pinBody(art) {
  return {
    programId: RESERVE_PROGRAM_ID,
    abi: art.abi,
    bytecode: art.bytecode,
    deployedBytecode: art.deployedBytecode,
  };
}

function samePin(pin, art) {
  const norm = (s) => String(s || '').replace(/^0x/i, '').toLowerCase();
  return pin.programId === RESERVE_PROGRAM_ID
    && norm(pin.bytecode) === art.bytecode
    && norm(pin.deployedBytecode) === art.deployedBytecode
    && JSON.stringify(pin.abi) === JSON.stringify(art.abi);
}

function isDirectRun() {
  const arg = process.argv[1];
  if (!arg) return false;
  return path.resolve(arg) === path.resolve(fileURLToPath(import.meta.url));
}

if (isDirectRun()) {
  const source = fs.readFileSync(srcPath, 'utf8');
  const next = applyReserveBooks(source);
  if (next !== source) fs.writeFileSync(srcPath, next);
  const art = compileReserveSource(next);
  const pin = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
  if (!samePin(pin, art)) {
    fs.writeFileSync(jsonPath, `${JSON.stringify(pinBody(art), null, 2)}\n`);
  }
  console.log('Reserve.json', art.bytecode.length / 2, 'bytes', next === source ? 'sol-unchanged' : 'sol-rewritten');
}
