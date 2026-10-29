// Bitcoin connect-and-send (Ledger Bitcoin app 2.x, native SegWit account 0).
// Pure helpers are exported for the offline vector tests.
import { AppClient, DefaultWalletPolicy, PsbtV2 } from 'ledger-bitcoin';
import * as bitcoin from 'bitcoinjs-lib';
import BIP32Factory from 'bip32';
import * as ecc from '@bitcoinerlab/secp256k1';
import { Buffer } from 'buffer';

const bip32 = BIP32Factory(ecc);
export const BTC_ACCOUNT = "84'/0'/0'";
const DUST = 546;

export function btcAddress(xpub, chain, index, network = bitcoin.networks.bitcoin) {
  const node = bip32.fromBase58(xpub, network).derive(chain).derive(index);
  return { address: bitcoin.payments.p2wpkh({ pubkey: Buffer.from(node.publicKey), network }).address, pubkey: Buffer.from(node.publicKey) };
}

export function vbytes(nIn, nOut) { return Math.ceil(10.5 + 68 * nIn + 31 * nOut); }

// Largest-first selection. utxos: [{txid, vout, value, chain, index, rawHex}]
export function btcSelect(utxos, amount, feeRate) {
  const sorted = utxos.slice().sort((a, b) => b.value - a.value);
  const picked = []; let total = 0;
  for (const u of sorted) {
    picked.push(u); total += u.value;
    const fee2 = vbytes(picked.length, 2) * feeRate;
    if (total >= amount + fee2) {
      const change = total - amount - fee2;
      if (change >= DUST) return { picked, fee: fee2, change };
      return { picked, fee: total - amount, change: 0 }; // dust change goes to the fee
    }
  }
  return null;
}

export function btcBuildPsbt({ picked, to, amount, change, changeIndex, xpub, fpr, network = bitcoin.networks.bitcoin }) {
  const acct = bip32.fromBase58(xpub, network);
  const fprBuf = Buffer.from(fpr, 'hex');
  const psbt = new bitcoin.Psbt({ network });
  for (const u of picked) {
    const prev = bitcoin.Transaction.fromHex(u.rawHex);
    if (prev.getId() !== u.txid) throw new Error('Previous transaction does not match its id');
    const out = prev.outs[u.vout];
    const pub = Buffer.from(acct.derive(u.chain).derive(u.index).publicKey);
    if (!out.script.equals(bitcoin.payments.p2wpkh({ pubkey: pub, network }).output)) throw new Error('UTXO is not ours');
    psbt.addInput({
      hash: u.txid, index: u.vout, sequence: 0xfffffffd,
      nonWitnessUtxo: Buffer.from(u.rawHex, 'hex'),
      witnessUtxo: { script: out.script, value: out.value },
      bip32Derivation: [{ masterFingerprint: fprBuf, path: "m/" + BTC_ACCOUNT + '/' + u.chain + '/' + u.index, pubkey: pub }],
    });
  }
  psbt.addOutput({ address: to, value: amount });
  if (change > 0) {
    const pub = Buffer.from(acct.derive(1).derive(changeIndex).publicKey);
    psbt.addOutput({
      address: bitcoin.payments.p2wpkh({ pubkey: pub, network }).address, value: change,
      bip32Derivation: [{ masterFingerprint: fprBuf, path: "m/" + BTC_ACCOUNT + '/1/' + changeIndex, pubkey: pub }],
    });
  }
  return psbt;
}

export function btcFinalize(psbt, sigs) {
  for (const [i, ps] of sigs) psbt.updateInput(i, { partialSig: [{ pubkey: Buffer.from(ps.pubkey), signature: Buffer.from(ps.signature) }] });
  const ok = psbt.validateSignaturesOfAllInputs((pub, hash, sig) => ecc.verify(hash, pub, sig));
  if (!ok) throw new Error('Ledger signature did not verify');
  psbt.finalizeAllInputs();
  return psbt.extractTransaction().toHex();
}

export function btcPolicy(fpr, xpub) {
  return new DefaultWalletPolicy('wpkh(@0/**)', '[' + fpr + '/' + BTC_ACCOUNT + ']' + xpub);
}

// Network calls (mempool.space), only reached after Connect.
async function getJson(url) {
  const r = await fetch(url, { credentials: 'omit', referrerPolicy: 'no-referrer' });
  if (!r.ok) throw new Error('API HTTP ' + r.status + ' for ' + new URL(url).pathname);
  return r.json();
}
async function getText(url) {
  const r = await fetch(url, { credentials: 'omit', referrerPolicy: 'no-referrer' });
  if (!r.ok) throw new Error('API HTTP ' + r.status);
  return r.text();
}

export async function btcSend(transport, net, to, amountStr, onStatus, parseUnits, formatUnits) {
  const app = new AppClient(transport);
  const fpr = await app.getMasterFingerprint();
  const xpub = await app.getExtendedPubkey("m/" + BTC_ACCOUNT, false);
  const amount = Number(parseUnits(amountStr, 8));
  if (amount < DUST) throw new Error('Minimum ' + formatUnits(BigInt(DUST), 8) + ' BTC');
  const api = net.api;
  onStatus('Your Ledger account: ' + btcAddress(xpub, 0, 0).address + '. Scanning it on ' + net.rpcHost + ' ...');
  const utxos = []; let changeIndex = null;
  for (const chain of [0, 1]) {
    let gap = 0;
    for (let i = 0; i < 40 && gap < 5; i++) {
      const { address } = btcAddress(xpub, chain, i);
      const st = await getJson(api + '/address/' + address);
      const used = st.chain_stats.tx_count + st.mempool_stats.tx_count;
      if (!used) { gap++; if (chain === 1 && changeIndex === null) changeIndex = i; continue; }
      gap = 0;
      const bal = st.chain_stats.funded_txo_sum - st.chain_stats.spent_txo_sum;
      if (bal > 0) {
        for (const u of await getJson(api + '/address/' + address + '/utxo')) {
          if (u.status && u.status.confirmed) utxos.push({ txid: u.txid, vout: u.vout, value: u.value, chain, index: i });
        }
      }
    }
  }
  const have = utxos.reduce((s, u) => s + u.value, 0);
  const fees = await getJson(api + '/v1/fees/recommended');
  const feeRate = Math.max(1, Math.ceil(fees.halfHourFee || fees.hourFee || 2));
  const sel = btcSelect(utxos, amount, feeRate);
  if (!sel) {
    const need = amount + vbytes(Math.max(1, utxos.length), 2) * feeRate;
    throw new Error('Balance too low: need about ' + formatUnits(BigInt(need), 8) + ' BTC including the fee (' + feeRate + ' sat/vB), have ' + formatUnits(BigInt(have), 8) + ' BTC confirmed');
  }
  onStatus('Fetching ' + sel.picked.length + ' previous transaction(s) ...');
  for (const u of sel.picked) u.rawHex = (await getText(api + '/tx/' + u.txid + '/hex')).trim();
  const psbt = btcBuildPsbt({ picked: sel.picked, to, amount, change: sel.change, changeIndex: changeIndex ?? 0, xpub, fpr });
  onStatus('Check the Ledger screen: ' + formatUnits(BigInt(amount), 8) + ' BTC to ' + to + ', fee ' + formatUnits(BigInt(sel.fee), 8) + ' BTC. Approve only if all match.');
  const sigs = await app.signPsbt(new PsbtV2().fromBitcoinJS(psbt), btcPolicy(fpr, xpub), null);
  const hex = btcFinalize(psbt, sigs);
  onStatus('Broadcasting through ' + net.rpcHost + ' ...');
  const r = await fetch(api + '/tx', { method: 'POST', body: hex, credentials: 'omit', referrerPolicy: 'no-referrer' });
  const txt = (await r.text()).trim();
  if (!r.ok) throw new Error('Broadcast refused: ' + txt);
  return { hash: txt };
}
