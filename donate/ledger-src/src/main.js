// Ledger connect-and-send for donate.shear.digital.
// Nothing here runs or calls the network until the visitor clicks Connect.
import TransportWebHID from '@ledgerhq/hw-transport-webhid';
import TransportWebBLE from '@ledgerhq/hw-transport-web-ble';
import Eth from '@ledgerhq/hw-app-eth';
import { Transaction, Signature, parseEther, formatEther, getAddress } from 'ethers';

export const support = {
  usb: typeof navigator !== 'undefined' && !!navigator.hid,
  ble: typeof navigator !== 'undefined' && !!navigator.bluetooth,
};

export async function connect(kind) {
  if (kind === 'usb') return TransportWebHID.create();
  if (kind === 'ble') return TransportWebBLE.create();
  throw new Error('Unknown connector');
}

const PATH = "44'/60'/0'/0/0";

async function rpc(url, method, params) {
  const r = await fetch(url, {
    method: 'POST', credentials: 'omit', referrerPolicy: 'no-referrer',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  if (!r.ok) throw new Error('RPC HTTP ' + r.status);
  const j = await r.json();
  if (j.error) throw new Error('RPC: ' + (j.error.message || 'error'));
  return j.result;
}

export async function evmAccount(transport) {
  const eth = new Eth(transport);
  const { address } = await eth.getAddress(PATH, false);
  return getAddress(address);
}

// Build an EIP-1559 send, sign it on the Ledger (visitor checks amount and
// our address on the device screen), then broadcast through the chosen RPC.
export async function evmSend(transport, chain, to, amountStr, onStatus) {
  const eth = new Eth(transport);
  const from = await evmAccount(transport);
  to = getAddress(to);
  const value = parseEther(String(amountStr));
  if (value <= 0n) throw new Error('Enter an amount above zero');
  onStatus('Reading nonce, fees and balance from ' + chain.rpcHost + ' ...');
  const [chainIdHex, nonceHex, block, tipHex, balHex] = await Promise.all([
    rpc(chain.rpc, 'eth_chainId', []),
    rpc(chain.rpc, 'eth_getTransactionCount', [from, 'pending']),
    rpc(chain.rpc, 'eth_getBlockByNumber', ['latest', false]),
    rpc(chain.rpc, 'eth_maxPriorityFeePerGas', []).catch(() => '0x3b9aca00'),
    rpc(chain.rpc, 'eth_getBalance', [from, 'latest']),
  ]);
  if (BigInt(chainIdHex) !== BigInt(chain.chainId)) throw new Error('RPC returned the wrong chain id');
  const base = BigInt(block.baseFeePerGas || 0);
  const tip = BigInt(tipHex);
  const maxFee = base * 2n + tip;
  const gasLimit = 21000n;
  const need = value + gasLimit * maxFee;
  if (BigInt(balHex) < need) {
    throw new Error('Balance too low: need up to ' + formatEther(need) + ' ' + chain.symbol + ' including fees, have ' + formatEther(BigInt(balHex)));
  }
  const tx = Transaction.from({
    type: 2, chainId: BigInt(chain.chainId), nonce: Number(BigInt(nonceHex)),
    to, value, gasLimit, maxFeePerGas: maxFee, maxPriorityFeePerGas: tip, data: '0x',
  });
  onStatus('Check the Ledger screen: amount ' + formatEther(value) + ' ' + chain.symbol + ' to ' + to + '. Approve only if both match.');
  const sig = await eth.signTransaction(PATH, tx.unsignedSerialized.slice(2), null);
  tx.signature = Signature.from({ r: '0x' + sig.r, s: '0x' + sig.s, v: Number(BigInt('0x' + sig.v)) });
  if (getAddress(tx.from) !== from) throw new Error('Signature does not match the Ledger account');
  onStatus('Broadcasting through ' + chain.rpcHost + ' ...');
  const hash = await rpc(chain.rpc, 'eth_sendRawTransaction', [tx.serialized]);
  return { hash, from };
}
