/**
 * Build contracts/dev/ReserveDev.json from a copy of Reserve.sol.
 * Does not write Reserve.sol or Reserve.json.
 * solc 0.8.36, optimizer runs 200, viaIR, shanghai — same as compile_reserve.js.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { compileReserveSource } from '../contracts/compile_reserve.js';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const srcPath = path.join(root, 'contracts', 'Reserve.sol');
const outPath = path.join(root, 'contracts', 'dev', 'ReserveDev.json');

export function reserveDevSource(source) {
  let next = String(source);
  if (!next.includes('bytes32 public constant SHEAR_MAINNET')) {
    throw new Error('Reserve.sol SHEAR_MAINNET constant missing');
  }
  if (!next.includes('uint256 public constant DAY_MS = 86_400_000;')) {
    throw new Error('Reserve.sol DAY_MS missing');
  }
  if (!next.includes('uint256 public constant ORACLE_MAX_AGE_MS = 14 * 86_400_000;')) {
    throw new Error('Reserve.sol ORACLE_MAX_AGE_MS missing');
  }
  next = next.replace(
    'bytes32 public constant SHEAR_MAINNET = keccak256(bytes("shear-v1"));',
    'bytes32 public constant SHEAR_MAINNET = keccak256(bytes("shear-v1"));\n    bytes32 public constant SHEAR_DEV = keccak256(bytes("shear-dev"));',
  );
  next = next.replace(
    'uint256 public constant DAY_MS = 86_400_000;',
    'uint256 public constant DAY_MS = 72_000;',
  );
  next = next.replace(
    'uint256 public constant ORACLE_MAX_AGE_MS = 14 * 86_400_000;',
    'uint256 public constant ORACLE_MAX_AGE_MS = 14 * 72_000;',
  );
  const allow = next.match(/if \(magic != SHEAR_TESTNET && magic != [\s\S]*?\) revert NotShear\(\);/);
  if (!allow) throw new Error('Reserve.sol allowlist missing');
  next = next.replace(allow[0], 'if (magic != SHEAR_DEV) revert NotShear();');
  if (next === source) throw new Error('Reserve dev substitutions did not apply');
  return next;
}

function pinBody(art) {
  return {
    programId: 'shear-reserve-v1',
    magic: 'shear-dev',
    abi: art.abi,
    bytecode: art.bytecode,
    deployedBytecode: art.deployedBytecode,
  };
}

const liveBefore = fs.readFileSync(srcPath);
const jsonPath = path.join(root, 'contracts', 'Reserve.json');
const jsonBefore = fs.readFileSync(jsonPath);
const source = reserveDevSource(liveBefore.toString('utf8'));
const art = compileReserveSource(source);
fs.mkdirSync(path.dirname(outPath), { recursive: true });
fs.writeFileSync(outPath, `${JSON.stringify(pinBody(art), null, 2)}\n`);
const liveAfter = fs.readFileSync(srcPath);
const jsonAfter = fs.readFileSync(jsonPath);
if (!liveBefore.equals(liveAfter) || !jsonBefore.equals(jsonAfter)) {
  throw new Error('gen_reserve_dev touched Reserve.sol or Reserve.json');
}
console.log('ReserveDev.json', art.bytecode.length / 2, 'bytes');
