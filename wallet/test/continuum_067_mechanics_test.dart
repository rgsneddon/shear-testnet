import 'dart:io';
import 'dart:isolate';
import 'dart:typed_data';

import 'package:flutter_test/flutter_test.dart';
import 'package:shear_wallet/main.dart';
import 'package:shear_wallet/shear_cli.dart';
import 'package:shear_wallet/shear_closure.dart';
import 'package:shear_wallet/shear_identity.dart';
import 'package:shear_wallet/shear_ledger.dart';
import 'package:shear_wallet/shear_read_sync.dart';
import 'package:shear_wallet/shear_reserve.dart';
import 'package:shear_wallet/shear_session.dart';

void main() {
  test('Continuum 0.70 build number comes from pubspec +N and is not 49', () {
    expect(kWalletVersion, '0.70');
    expect(kCliVersion, '0.70');
    expect(kBookMagic, 'shear-testnet-v10');
    final pubspec = File('pubspec.yaml').readAsStringSync();
    expect(pubspec, contains('version: 0.70.0+95'));
    final plus = RegExp(r'version:\s*0\.70\.0\+(\d+)').firstMatch(pubspec);
    expect(plus, isNotNull);
    final build = int.parse(plus!.group(1)!);
    expect(build, greaterThan(91));
    expect(build, isNot(49));
    final pack = File('pack/pack_android.sh').readAsStringSync();
    expect(pack, isNot(contains('BUILD_NUMBER:-49')));
    expect(pack, contains('PUBSPEC_PLUS'));
    expect(pack, contains('ANDROID_BUILD_NUMBER_NOT_ABOVE_91'));
    expect(pubspec, contains('Displayed pin is 0.70.'));
    expect(pubspec, isNot(contains('Displayed pin is 0.66.')));
    final buildLine = pack.split('\n').where((l) => l.contains('flutter build apk')).join('\n');
    expect(buildLine, contains('flutter build apk'));
    expect(buildLine, isNot(contains('--split-per-abi')));
    final gradle = File('android/app/build.gradle.kts').readAsStringSync();
    expect(gradle, contains('signingConfigs.getByName("release")'));
    expect(gradle, isNot(contains('signingConfig = signingConfigs.getByName("debug")')));
    expect(gradle, contains('Missing wallet/android/key.properties'));
    final manifest = File('android/app/src/main/AndroidManifest.xml').readAsStringSync();
    expect(manifest, contains('android:allowBackup="false"'));
    expect(manifest, contains('android:fullBackupContent="false"'));
    final appId = File('android/app/build.gradle.kts').readAsStringSync();
    expect(appId, contains('applicationId = "com.shear.shear_wallet"'));
  });

  test('HTML 200 is not a live node and JSON height >= 1 is', () async {
    expect(decodeNodeJson('<html><body>pool</body></html>', contentType: 'text/html'), isNull);
    expect(decodeNodeJson('<!DOCTYPE html><html></html>'), isNull);
    expect(isUsableTipStats(decodeNodeJson('<html></html>')), isFalse);
    final stats = decodeNodeJson('{"height":4,"header":"aa"}', contentType: 'application/json');
    expect(stats, isNotNull);
    expect(isUsableTipStats(stats), isTrue);
    expect(isUsableTipStats(decodeNodeJson('{"height":0}')), isFalse);

    final html = await HttpServer.bind(InternetAddress.loopbackIPv4, 0);
    addTearDown(() => html.close(force: true));
    html.listen((req) async {
      req.response.statusCode = 200;
      req.response.headers.contentType = ContentType.html;
      req.response.write('<!DOCTYPE html><html><title>seed</title></html>');
      await req.response.close();
    });
    final dead = ShearReadSync(
      seeds: ['http://127.0.0.1:${html.port}'],
      http: HttpClient()..connectionTimeout = const Duration(seconds: 2),
      jitter: Duration.zero,
    );
    expect(await dead.findLiveNode(), isNull);
    expect(dead.liveBase, isNull);

    final json = await HttpServer.bind(InternetAddress.loopbackIPv4, 0);
    addTearDown(() => json.close(force: true));
    json.listen((req) async {
      req.response.statusCode = 200;
      req.response.headers.contentType = ContentType.json;
      req.response.write('{"height":4,"header":"aa","magic":"shear-testnet-v10"}');
      await req.response.close();
    });
    final live = ShearReadSync(
      seeds: ['http://127.0.0.1:${json.port}'],
      http: HttpClient()..connectionTimeout = const Duration(seconds: 2),
      jitter: Duration.zero,
    );
    final found = await live.findLiveNode();
    expect(found, 'http://127.0.0.1:${json.port}');
    expect(live.liveBase, found);
  });

  test('sealed height alone is not synced', () {
    final sealedOnly = tipHud(sealed: 86, seek: null, live: false, ibd: false);
    expect(sealedOnly.synced, isFalse);
    expect(sealedOnly.amber, isTrue);
    expect(sealedOnly.syncWord, 'no live node');
    expect(sealedOnly.label, contains('sealed 86'));
    expect(sealedOnly.label, isNot(contains('synchronised')));
    final seeking = tipHud(sealed: 86, seek: 270, live: true, ibd: true);
    expect(seeking.synced, isFalse);
    expect(seeking.amber, isTrue);
    expect(seeking.label, contains('seek 270'));
    final caught = tipHud(sealed: 270, seek: 270, live: true, ibd: false);
    expect(caught.synced, isTrue);
    expect(caught.amber, isFalse);
    expect(caught.syncWord, startsWith('synchronised'));
  });

  test('rememberSpendable does not raise Spendable above reconstructed notes', () {
    final ledger = ShearLedger();
    final id = createIdentity();
    ledger.bindIdentity(id);
    final dest = ledger.currentDest(id.address);
    ledger.rememberSpendable(dest, 9);
    expect(ledger.spendable(dest), 0);
  });

  test('Apply to Bare marks the seeker dishonest', () async {
    final side = ShearNodeSidecar(datadirEmpty: () => true);
    side.select(ClosureSendMode.connectBare);
    await side.apply();
    expect(side.seekerDishonest, isTrue);
    expect(side.seekerTip, 0);
    expect(side.committed, ClosureSendMode.connectBare);
  });

  test('unchanged magic keeps the session file', () async {
    final dir = Directory.systemTemp.createTempSync('continuum-067-session');
    addTearDown(() => dir.deleteSync(recursive: true));
    final store = File('${dir.path}/session.json');
    final session = ShearSession(store: store);
    await session.loadOrCreate();
    await session.setPassword('correct horse battery staple');
    final she1 = session.identity!.paymentCode;
    await session.persist();
    expect(store.existsSync(), isTrue);
    final again = ShearSession(store: store);
    await again.unlock('correct horse battery staple');
    expect(again.identity!.paymentCode, she1);
    expect(kBookMagic, 'shear-testnet-v10');
  });

  test('unsealed vault observe does not mint Spendable and Sign is local-only', () {
    expect(vaultObserveLabel(sealed: false), contains('advisory'));
    expect(vaultObserveLabel(sealed: false), contains('not book-final'));
    expect(spendableFromVaultObserve(sealed: false, oracleNanos: 9), 0);
    expect(spendableFromVaultObserve(sealed: true, oracleNanos: 9), 0);
    expect(reserveWithdrawDialogCopy(), contains('local-only'));
    expect(reserveWithdrawDialogCopy(), contains('Not full custody'));
    final mainSrc = File('lib/main.dart').readAsStringSync();
    expect(mainSrc, contains('vaultObserveLabel(sealed: false)'));
    final unlock = mainSrc.indexOf('Future<void> _enterWallet');
    final finish = mainSrc.indexOf('Future<void> _finishUnlockSync');
    expect(unlock, greaterThan(0));
    expect(finish, greaterThan(unlock));
    final open = mainSrc.substring(unlock, finish);
    expect(open, contains('await _finishUnlockSync()'));
    expect(
      open.indexOf('await _finishUnlockSync()'),
      lessThan(open.indexOf('unlocked = true')),
    );
    expect(open.contains('_verifying = true'), isFalse);
    expect(open.contains('await syncCredits'), isFalse);
    expect(shearKPoolUrl(publicPool: true), 'stratum+ssl://pool.shear.digital:443');
    expect(shearKPoolUrl(publicPool: false), 'stratum+tcp://127.0.0.1:1111');
    expect(
      closureSpawnEnv(ClosureSendMode.localNodeFull, android: false, dataDir: 'book', publicStratum: true)['SHEARK_POOL'],
      'stratum+ssl://pool.shear.digital:443',
    );
    final follow = mainSrc.indexOf('Future<void> _followCredits');
    expect(follow, greaterThan(0));
    expect(finish, greaterThan(follow));
    final unlockBody = mainSrc.substring(finish, mainSrc.indexOf('Future<void> _onNodeTip'));
    expect(unlockBody, contains('spendableFirst: true'));
    expect(unlockBody.contains('chain: false'), isFalse);
    expect(unlockBody.contains('await ledger.syncCredits'), isFalse);
    expect(unlockBody.contains('await ledger.syncBalancesOnly'), isFalse);
    expect(unlockBody, contains('_followCredits'));
    final applyAt = mainSrc.indexOf("key: const Key('closure-apply')");
    expect(applyAt, greaterThan(0));
    final applyBody = mainSrc.substring(applyAt, applyAt + 1800);
    expect(applyBody.contains('await ledger.syncCredits'), isFalse);
    expect(applyBody.contains('await ledger.syncBalancesOnly'), isFalse);
    expect(applyBody, contains('_followBalancesAfterApply'));
    final after = mainSrc.indexOf('Future<void> _followBalancesAfterApply');
    expect(after, greaterThan(0));
    expect(mainSrc.substring(after, after + 700), contains('_followCredits'));
  });

  test('IBD balance follow runs off the UI isolate and does not invent Spendable', () async {
    debugCreditFollowKinds.clear();
    debugCreditFollowStamps.clear();
    final paths = <String>[];
    final server = await HttpServer.bind(InternetAddress.loopbackIPv4, 0);
    addTearDown(() => server.close(force: true));
    server.listen((req) async {
      paths.add(req.uri.path);
      req.response.statusCode = 200;
      req.response.headers.contentType = ContentType.json;
      req.response.write('{"height":1,"header":"aa","balance":1000,"owedPi":1000,"notes":[],"txs":[],"headers":[]}');
      await req.response.close();
    });
    final id = createIdentity();
    final ledger = ShearLedger(pool: ShearPoolClient(baseUrl: 'http://127.0.0.1:${server.port}'))
      ..bindIdentity(id);
    final home = ledger.homeDest(id.address, paymentCode: id.paymentCode);
    ledger.rememberNote({
      'address': home,
      'dest': home,
      'verified': true,
      'height': 2,
      'amount': 0.4,
      'commit': Uint8List(32)..[0] = 1,
      'r': Uint8List(32)..[0] = 2,
    });
    ledger.settleTo(2 + ShearLedger.spendableConfirmations - 1);
    final caller = identityHashCode(Isolate.current).toString();
    final opened = await ledger.followOffUi(
      restFrame: id.address,
      paymentCode: id.paymentCode,
      full: false,
    );
    expect(debugCreditFollowKind, 'balances');
    expect(debugCreditFollowStamp, isNotEmpty);
    expect(debugCreditFollowStamp, isNot(caller));
    expect(paths.any((p) => p.contains('balance')), isTrue);
    expect(paths.any((p) => p.contains('notes')), isFalse);
    expect(paths.any((p) => p.contains('history')), isFalse);
    expect(opened, closeTo(0.4, 1e-9));
    expect(ledger.spendable(home), closeTo(0.4, 1e-9));
    expect(ledger.spendableOwned(id.address, paymentCode: id.paymentCode), closeTo(0.4, 1e-9));
  });
}
