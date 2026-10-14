import { randomBytes } from 'crypto';

/** docs/wallet-auto-send-delay.md — the same constant the Dart wallet uses. */
export const Q_EPOCH_BLOCKS = 8;
export const AUTO_SEND_DELAY_WEIGHTS = [4, 12, 28, 52, 68, 52, 28, 12];

export function autoSendEpoch(sealedTip) {
  if (!Number.isInteger(sealedTip) || sealedTip < 0) throw new Error('sealedTip');
  return Math.floor(sealedTip / Q_EPOCH_BLOCKS);
}

export function autoSendDelayEpochs(byte) {
  if (!Number.isInteger(byte) || byte < 0 || byte > 255) throw new Error('byte');
  let acc = 0;
  for (let i = 0; i < AUTO_SEND_DELAY_WEIGHTS.length; i++) {
    acc += AUTO_SEND_DELAY_WEIGHTS[i];
    if (byte < acc) return i;
  }
  throw new Error('auto_send_weights');
}

export function drawHold({ sealedTip, byte }) {
  const epochBase = autoSendEpoch(sealedTip);
  const epochs = autoSendDelayEpochs(byte);
  return { v: 1, epochBase, epochs, releaseEpoch: epochBase + epochs };
}

export function holdReady(hold, sealedTip) {
  if (!hold || hold.v !== 1) return false;
  return autoSendEpoch(sealedTip) >= hold.releaseEpoch;
}

/** Queue an automatic send. An existing hold is reused, not redrawn. */
export function queueAutomaticSend({ hold, sealedTip, byte }) {
  const next = hold ?? drawHold({ sealedTip, byte });
  return { hold: next, ready: holdReady(next, sealedTip) };
}

/** Manual sends are not delayed. */
export function manualSendAllowed() {
  return true;
}

export function csprngByte() {
  const b = randomBytes(1);
  if (!b || b.length !== 1) throw new Error('rng_unavailable');
  return b[0];
}
