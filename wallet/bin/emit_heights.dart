import 'package:shear_wallet/shear_ledger.dart';

String _hex(List<int> b) => b.map((x) => x.toRadixString(16).padLeft(2, '0')).join();

/// What a chain read tells a real wallet, from the node e2e fixture: the tip,
/// and the block height each note's commitment was mined at. Spendable needs
/// both (spendableNote: a height with the required confirmations); a note the
/// chain has not mined keeps no height and stays Pending.
void applyChainHeights(ShearLedger ledger, Map raw) {
  final tip = raw['tip'];
  final heights = raw['heights'];
  if (heights is Map) {
    for (final n in ledger.notes) {
      final commit = n['commit'];
      if (commit is! List<int>) continue;
      final h = heights[_hex(commit)];
      if (h is int && h >= 1) n['height'] = h;
    }
  }
  if (tip is int && tip >= 1) {
    ledger.noteLiveHeight(tip);
    ledger.settleTo(tip);
  }
}
