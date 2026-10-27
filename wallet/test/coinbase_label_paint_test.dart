import 'dart:typed_data';

import 'package:flutter_test/flutter_test.dart';
import 'package:shear_wallet/shear_admit.dart';
import 'package:shear_wallet/shear_identity.dart';
import 'package:shear_wallet/shear_ledger.dart';
import 'package:shear_wallet/shear_note.dart';
import 'package:shear_wallet/shear_ristretto.dart';

// A miner's coinbase pot, sealed and wrapped to the miner, with its label
// (noteCommit) set to another dest's. Consensus refuses it (COINBASE_NC=
// dest-bound, Russell 26 Oct); this is the wallet's own guard under that:
// the dest the label names never counts the row, so its Spendable is
// never painted by a label it cannot open.
void main() {
  test('a coinbase row labelled with another dest\'s noteCommit is never that dest\'s note', () {
    final miner = createIdentity();
    final victim = createIdentity();
    final minerLedger = ShearLedger()..bindIdentity(miner);
    final victimLedger = ShearLedger()..bindIdentity(victim);
    final minerDest = minerLedger.homeDest(miner.address, paymentCode: miner.paymentCode);
    final victimDest = victimLedger.homeDest(victim.address, paymentCode: victim.paymentCode);
    final minerD20 = hash20FromAddress(minerDest)!;
    final victimLabel = noteCommitOfDest20(hash20FromAddress(victimDest)!);
    final seed = minerLedger.spendSeed!;

    Map<String, dynamic> row(Uint8List label) {
      var n = sealCoinbaseNote(250000000, dest20: minerD20, noteCommit: label, kind: 'pot');
      n['admitPub'] = pointBytes(admitPub(admitScalarFromSeed(seed, {
        'kind': 'pot',
        'noteCommit': n['noteCommit'],
        'commit': n['commit'],
      })));
      n = wrapNoteBlind(n, admitPub(admitBaseScalar(seed)));
      n.remove('r');
      n['dest20'] = minerD20;
      n['height'] = 1;
      return n;
    }

    List<Map> scan(ShearLedger ledger, String dest, Map<String, dynamic> vout) =>
        (scanSealedVouts({
          'vouts': [vout],
          'dests': [dest],
          'dest': dest,
          'spendSeed': ledger.spendSeed,
        })['notes'] as List)
            .cast<Map>();

    // Control: the same row under the miner's own label is the miner's note.
    // The scan finds and unwraps it; it does not open a coinbase value here.
    final honest = row(noteCommitOfDest20(minerD20));
    final mine = scan(minerLedger, minerDest, honest);
    expect(mine, hasLength(1));
    expect(noteBytesEq(mine.single['commit'] as Uint8List, honest['commit'] as Uint8List), isTrue);
    expect(mine.single['kind'], 'pot');

    // Painted: the victim's label on the miner's row. The victim's wallet
    // matches the label, cannot unwrap or re-derive the admit key, and skips it.
    final painted = row(victimLabel);
    expect(noteBytesEq(painted['noteCommit'] as Uint8List, victimLabel), isTrue);
    expect(scan(victimLedger, victimDest, painted), isEmpty);
  });
}
