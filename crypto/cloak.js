import { createHmac } from 'node:crypto';

export function shearTag(identity, tipHash, salt) {
  const mac = createHmac('sha256', Buffer.from(String(salt || 'shear-cloak-v1')));
  mac.update(String(identity || ''));
  mac.update('|');
  mac.update(String(tipHash || ''));
  return `shear-${mac.digest('hex').slice(0, 20)}`;
}

export function canOpenView(viewKey, identityViewKey) {
  return String(viewKey || '') === String(identityViewKey || '') && Boolean(viewKey);
}
