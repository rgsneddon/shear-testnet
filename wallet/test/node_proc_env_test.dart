import 'package:flutter_test/flutter_test.dart';
import 'package:shear_wallet/main.dart';

void main() {
  test('the shared node launch drops bootstrap and seed overrides', () {
    final passed = sharedNodeLaunchEnv(
      {
        'PATH': '/usr/bin',
        'SystemRoot': r'C:\Windows',
        'HOME': '/home/me',
        'SHEAR_BOOTSTRAP': '1',
        'SHEAR_BOOTSTRAP_URL': 'https://boot.shear.digital',
        'SHEAR_SEEDS': 'evil.example:30303',
      },
      {
        'SHEAR_DATA': '/tmp/book',
        'SHEAR_RPC_BIND': '127.0.0.1',
        'SHEAR_BOOTSTRAP': '1',
      },
      workDir: '/opt/shear',
    );
    expect(passed.containsKey('SHEAR_BOOTSTRAP'), isFalse);
    expect(passed.containsKey('SHEAR_BOOTSTRAP_URL'), isFalse);
    expect(passed.containsKey('SHEAR_SEEDS'), isFalse);
    expect(passed['SystemRoot'], r'C:\Windows');
    expect(passed['HOME'], '/home/me');
    expect(passed['SHEAR_DATA'], '/tmp/book');
    expect(passed['SHEAR_RPC_BIND'], '127.0.0.1');
    expect(passed['PATH'], contains('/usr/bin'));
    expect(passed['PATH'], contains('${'/opt/shear'}/runtime'));
  });
}
