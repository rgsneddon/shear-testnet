import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import solc from 'solc';

const dir = path.dirname(fileURLToPath(import.meta.url));
const srcPath = path.join(dir, 'Reserve.sol');
const source = fs.readFileSync(srcPath, 'utf8');
const input = {
  language: 'Solidity',
  sources: { 'Reserve.sol': { content: source } },
  settings: {
    optimizer: { enabled: true, runs: 200 },
    outputSelection: { '*': { '*': ['abi', 'evm.bytecode.object', 'evm.deployedBytecode.object'] } },
  },
};
const out = JSON.parse(solc.compile(JSON.stringify(input)));
if (out.errors && out.errors.some((e) => e.severity === 'error')) {
  for (const e of out.errors) console.error(e.formattedMessage || e.message);
  process.exit(1);
}
const art = out.contracts['Reserve.sol'].Reserve;
const pin = {
  programId: 'shear-reserve-v1',
  abi: art.abi,
  bytecode: art.evm.bytecode.object,
  deployedBytecode: art.evm.deployedBytecode.object,
};
fs.writeFileSync(path.join(dir, 'Reserve.json'), JSON.stringify(pin, null, 2) + '\n');
console.log('Reserve.json', pin.bytecode.length / 2, 'bytes');
