import 'package:flutter_test/flutter_test.dart';
import 'package:shear_wallet/shear_ctf.dart';
import 'package:shear_wallet/shear_identity.dart';

/// Form B is spendHash20 ‖ closure ‖ index, 60 bytes, 120 hex chars.
/// `openingForDest` is what `destProofOpen` puts on a remote read.
void main() {
  test('openingForDest never returns the second opening form', () {
    final id = createIdentity();
    final spendH = spendHashFromAddress(id.address);
    expect(spendH, isNotNull);
    final closure = closureCommit(id.viewKey);
    final vault = vaultDest(id.address, viewKey: id.viewKey);
    expect(vault, isNotNull);
    final vaultFormB = indexedDestOpening(spendH!, closure, 0);
    expect(vaultFormB.length, 120);

    final fromVault = openingForDest(
      from: vault!,
      restFrame: id.address,
      viewKey: id.viewKey,
    );
    expect(fromVault, isNull);
    expect(fromVault, isNot(vaultFormB));

    final indexed = destAtIndex(id.address, index: 3, viewKey: id.viewKey);
    expect(indexed, isNotNull);
    expect(indexed, isNot(vault));
    final indexedFormB = indexedDestOpening(spendH, closure, 3);
    expect(indexedFormB.length, 120);
    final fromIndexed = openingForDest(
      from: indexed!,
      restFrame: id.address,
      viewKey: id.viewKey,
      destCount: 8,
    );
    expect(fromIndexed, isNull);
    expect(fromIndexed, isNot(indexedFormB));
  });
}
