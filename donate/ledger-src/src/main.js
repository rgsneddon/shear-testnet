// Ledger connect-and-send for donate.shear.digital.
// Nothing here runs or calls the network until the visitor clicks Connect.
import TransportWebHID from '@ledgerhq/hw-transport-webhid';
import TransportWebBLE from '@ledgerhq/hw-transport-web-ble';
import TransportWebUSB from '@ledgerhq/hw-transport-webusb';
import Eth from '@ledgerhq/hw-app-eth';
import { Transaction, Signature, parseEther, formatEther, getAddress } from 'ethers';
import Solana from '@ledgerhq/hw-app-solana';
import { PublicKey, SystemProgram, Transaction as SolTx } from '@solana/web3.js';
import { Buffer } from 'buffer';

export const support = {
  hid: typeof navigator !== 'undefined' && !!navigator.hid,
  webusb: typeof navigator !== 'undefined' && !!navigator.usb,
  usb: typeof navigator !== 'undefined' && (!!navigator.hid || !!navigator.usb),
  ble: typeof navigator !== 'undefined' && !!navigator.bluetooth,
};

export async function connect(kind) {
  // Desktop: WebHID. Android Chrome has no WebHID, so fall back to WebUSB.
  if (kind === 'usb') return navigator.hid ? TransportWebHID.create() : TransportWebUSB.create();
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

// ---- Solana ----
const SOL_PATH = "44'/501'/0'";

export function parseUnits(str, decimals) {
  const m = /^(\d+)(?:\.(\d+))?$/.exec(String(str).trim());
  if (!m) throw new Error('Enter an amount like 0.01');
  const frac = m[2] || '';
  if (frac.length > decimals) throw new Error('Too many decimal places (max ' + decimals + ')');
  return BigInt(m[1]) * 10n ** BigInt(decimals) + BigInt((frac + '0'.repeat(decimals)).slice(0, decimals) || '0');
}
export function formatUnits(v, decimals) {
  const s = v.toString().padStart(decimals + 1, '0');
  const i = s.slice(0, -decimals), f = s.slice(-decimals).replace(/0+$/, '');
  return f ? i + '.' + f : i;
}

export async function solAccount(transport) {
  const sol = new Solana(transport);
  const { address } = await sol.getAddress(SOL_PATH);
  return new PublicKey(address).toBase58();
}

export async function solSend(transport, net, to, amountStr, onStatus) {
  const sol = new Solana(transport);
  const from = new PublicKey(await solAccount(transport));
  const dest = new PublicKey(to);
  const lamports = parseUnits(amountStr, 9);
  if (lamports < 1000000n) throw new Error('Minimum 0.001 SOL');
  onStatus('Reading balance and a recent blockhash from ' + net.rpcHost + ' ...');
  const [bal, bh] = await Promise.all([
    rpc(net.rpc, 'getBalance', [from.toBase58(), { commitment: 'confirmed' }]),
    rpc(net.rpc, 'getLatestBlockhash', [{ commitment: 'confirmed' }]),
  ]);
  const fee = 5000n;
  if (BigInt(bal.value) < lamports + fee) {
    throw new Error('Balance too low: need ' + formatUnits(lamports + fee, 9) + ' SOL including the fee, have ' + formatUnits(BigInt(bal.value), 9));
  }
  // An account that stays open must keep Solana's rent-exempt reserve; the network
  // rejects a transfer that leaves it between zero and the reserve.
  const RENT_RESERVE = 890880n;
  const left = BigInt(bal.value) - lamports - fee;
  if (left !== 0n && left < RENT_RESERVE) {
    throw new Error('Balance too low: Solana keeps ' + formatUnits(RENT_RESERVE, 9) + ' SOL in an open account. Send at most ' +
      formatUnits(BigInt(bal.value) - fee - RENT_RESERVE > 0n ? BigInt(bal.value) - fee - RENT_RESERVE : 0n, 9) +
      ' SOL, or send the whole balance less the fee (' + formatUnits(BigInt(bal.value) - fee, 9) + ' SOL).');
  }
  const tx = new SolTx({ feePayer: from, recentBlockhash: bh.value.blockhash })
    .add(SystemProgram.transfer({ fromPubkey: from, toPubkey: dest, lamports: Number(lamports) }));
  onStatus('Check the Ledger screen: ' + formatUnits(lamports, 9) + ' SOL to ' + dest.toBase58() + '. Approve only if both match.');
  const { signature } = await sol.signTransaction(SOL_PATH, tx.serializeMessage());
  tx.addSignature(from, Buffer.from(signature));
  if (!tx.verifySignatures()) throw new Error('Signature does not match the Ledger account');
  onStatus('Broadcasting through ' + net.rpcHost + ' ...');
  const hash = await rpc(net.rpc, 'sendTransaction', [tx.serialize().toString('base64'), { encoding: 'base64', preflightCommitment: 'confirmed' }]);
  return { hash, from: from.toBase58() };
}

// ---- Bitcoin ----
import * as btc from './btc.js';
export const BTC = btc;
export function btcSend(transport, net, to, amountStr, onStatus) {
  return btc.btcSend(transport, net, to, amountStr, onStatus, parseUnits, formatUnits);
}
