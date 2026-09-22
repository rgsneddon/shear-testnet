import 'dart:convert';
import 'dart:io';
import 'dart:typed_data';

import 'package:flutter_test/flutter_test.dart';
import 'package:shear_wallet/shear_identity.dart';
import 'package:shear_wallet/shear_ledger.dart';
import 'package:shear_wallet/shear_note.dart';
import 'package:shear_wallet/shear_ristretto.dart';

void main() {
  test('note H is the consensus bpplus point', () {
    final hex = pointBytes(noteH).map((b) => b.toRadixString(16).padLeft(2, '0')).join();
    expect(hex, 'feea2914bda937d74acc1efa93bf1094f65ae709628a7aad9d1b913b6c80c301');
  });

  test('10 SHE reserve seal verifies under consensus H', () {
    final vault = encodeDestAddress(Uint8List.fromList(List.filled(20, 9)));
    final nanos = (10 * kUnitsPerShe).round();
    final sealed = compactSealedVout(sealedReserveVout(vault, nanos, 'lock'));
    expect(sealed['valueProof'], isA<Map>());
    expect((sealed['valueProof'] as Map)['v'], nanos);
    final file = File('${Directory.systemTemp.path}${Platform.pathSeparator}shear-lock-10-$pid.json');
    file.writeAsStringSync(jsonEncode({
      'kind': 'lock',
      'to': vault,
      'nanos': nanos,
      'vout': [sealed],
    }));
    addTearDown(() {
      try {
        file.deleteSync();
      } catch (_) {}
    });
    final repo = Directory.current.path.replaceAll('\\', '/').endsWith('/wallet')
        ? Directory.current.parent.path
        : Directory.current.path;
    final checked = Process.runSync(
      'node',
      ['tests/verify_lock_seal.mjs', file.path],
      workingDirectory: repo,
    );
    expect(checked.exitCode, 0, reason: '${checked.stdout}${checked.stderr}');
    final got = jsonDecode(checked.stdout as String) as Map;
    expect(got['sealOk'], true);
    expect(got['ok'], true);
    expect(got['v'], nanos);
  });
}
