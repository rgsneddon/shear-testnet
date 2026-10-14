import 'dart:ffi';
import 'dart:typed_data';

import 'package:flutter_test/flutter_test.dart';
import 'package:shear_wallet/shear_admit_ffi.dart';

void main() {
  tearDown(() {
    AdmitNative.debugSecretBeforeFree = null;
    AdmitNative.debugRange = null;
  });

  test('calloc secret is zero before free and the caller opening stays', () {
    final seen = <int>[];
    AdmitNative.debugSecretBeforeFree = (Pointer<Uint8> p, int n) {
      for (var i = 0; i < n; i++) {
        seen.add(p[i]);
      }
    };
    AdmitNative.debugRange = (int v, Pointer<Uint8> r, Pointer<Uint8> out, Pointer<Uint32> olen, int cap) {
      expect(v, 1);
      expect(cap, AdmitNative.rangeCap);
      expect(r[0], 0x5a);
      out[0] = 2;
      olen.value = 1;
      return 1;
    };
    final opening = Uint8List(32)..[0] = 0x5a;
    final proof = AdmitNative.debug().proveRange(BigInt.one, opening);
    expect(proof, isNotNull);
    expect(proof!.first, 2);
    expect(seen, hasLength(32));
    expect(seen, everyElement(0));
    expect(opening[0], 0x5a);
  });
}
