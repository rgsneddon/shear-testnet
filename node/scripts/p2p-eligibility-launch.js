import { applyTipAdvertisement, catchupFields, markSyncEligible, syncSnapshot } from '../src/p2p.js';

const gossip = { height: 0, hash: null, work: null };
applyTipAdvertisement(gossip, {
  type: 'tip',
  relay: true,
  height: 270,
  hash: 'ab'.repeat(32),
  work: '0xff',
}, { localHeight: 210, localHash: '11'.repeat(32) });
const gossipFields = catchupFields(gossip);
if (gossip.syncEligible === true) {
  console.error('gossip-only peer became sync-eligible');
  process.exit(1);
}
if (gossipFields.height != null || gossipFields.work != null || gossipFields.hash !== '') {
  console.error('gossip wrote catch-up height or work');
  process.exit(1);
}

const proven = { height: 0, hash: null, work: null };
applyTipAdvertisement(proven, {
  type: 'tip',
  height: 11,
  hash: 'cd'.repeat(32),
  work: '0x20',
}, { localHeight: 4, localHash: '22'.repeat(32) });
if (proven.syncEligible === true || proven.height === 11 || proven.work === '0x20') {
  console.error('direct tip inflated catch-up before a body');
  process.exit(1);
}
markSyncEligible(proven, { height: 5, hash: 'ee'.repeat(32), work: '0x10', reason: 'body' });
const provenFields = catchupFields(proven);
const snap = syncSnapshot(new Map([['sock', proven]]));
if (proven.syncEligible !== true || provenFields.height !== 5 || provenFields.height === 11) {
  console.error('body-proven peer is not sync-eligible at the applied height');
  process.exit(1);
}
if (snap.syncPeerHeight !== 5 || snap.syncPeerHeight === 11 || snap.peerMaxHeight !== 11) {
  console.error('syncPeerHeight followed the tip advertisement');
  process.exit(1);
}

console.log(JSON.stringify({
  gossipEligible: false,
  gossipCatchupHeight: gossipFields.height,
  bodyEligible: true,
  bodyCatchupHeight: provenFields.height,
  syncPeerHeight: snap.syncPeerHeight,
  peerMaxHeight: snap.peerMaxHeight,
}));
