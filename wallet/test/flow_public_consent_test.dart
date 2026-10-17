import 'dart:async';
import 'dart:convert';
import 'dart:io';
import 'dart:typed_data';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:shear_wallet/main.dart';
import 'package:shear_wallet/shear_cli.dart';
import 'package:shear_wallet/shear_identity.dart';
import 'package:shear_wallet/shear_ledger.dart';
import 'package:shear_wallet/shear_public_confirm.dart';
import 'package:shear_wallet/shear_read_sync.dart';
import 'package:shear_wallet/shear_session.dart';

void main() {
  test('docs and the Flow gate agree, and a local send does not ask', () async {
    final docs = File('../site/docs/content.js').readAsStringSync().replaceAll(r"\'", "'");
    final ui = File('lib/main.dart').readAsStringSync();
    expect(docs, contains(kPublicNodeEverySendCopy));
    expect(docs.contains('confirm a VPN or accept that the node may see your IP'), isFalse);
    expect(docs.contains('full privacy'), isFalse);
    expect(kPublicIpWaitCopy, kPublicNodeEverySendCopy);
    expect(kCliHelp, contains(kPublicNodeEverySendCopy));
    expect(File('lib/shear_cli.dart').readAsStringSync(), contains(r'$kPublicNodeEverySendCopy'));
    expect(kUnprivateConfirmHelper, kPublicNodeEverySendCopy);
    expect(RegExp(r'\btor\b').hasMatch(kPublicNodeEverySendCopy.toLowerCase()), isFalse);
    expect(ui, contains('_flowPublicConsent'));
    expect(ui, contains('publicNode: _flowPostsToPublicNode()'));

    final id = createIdentity();
    final ledger = ShearLedger()..bindIdentity(id);
    final bobId = createIdentity();
    final bob = (ShearLedger()..bindIdentity(bobId)).homeDest(
      bobId.address,
      paymentCode: bobId.paymentCode,
    );

    final refused = await submitContinuumSend(
      ledger: ledger,
      restFrame: id.address,
      paymentCode: id.paymentCode,
      startTo: '',
      enteredTo: bob,
      amount: 0.1,
      local: false,
      allowPublicHttp: true,
      publicNode: true,
    );
    expect(refused.posted, isFalse);
    expect(refused.remark, kPublicIpWaitCopy);
    expect(ledger.transactions, isEmpty);

    final opened = await submitContinuumSend(
      ledger: ledger,
      restFrame: id.address,
      paymentCode: id.paymentCode,
      startTo: '',
      enteredTo: bob,
      amount: 0.1,
      local: false,
      allowPublicHttp: true,
      publicNode: true,
      publicIpConsent: true,
    );
    expect(opened.posted, isFalse);
    expect(opened.remark, isNot(kPublicIpWaitCopy));
    expect(opened.remark, kErrSendGeneric);

    final local = await submitContinuumSend(
      ledger: ledger,
      restFrame: id.address,
      paymentCode: id.paymentCode,
      startTo: '',
      enteredTo: bob,
      amount: 0.1,
      local: true,
      allowPublicHttp: false,
      publicNode: true,
    );
    expect(local.remark, isNot(kPublicIpWaitCopy));
    expect(ledger.transactions.where((t) => t.kind == 'send'), isEmpty);

    await expectLater(
      ledger.consolidateSpendableNotes(
        restFrame: id.address,
        paymentCode: id.paymentCode,
        spendSeed: Uint8List(32),
        allowPublicHttp: true,
        publicNode: true,
      ),
      throwsA(isA<StateError>().having((e) => e.message, 'message', kPublicIpWaitCopy)),
    );
    final rounds = await ledger.consolidateSpendableNotes(
      restFrame: id.address,
      paymentCode: id.paymentCode,
      spendSeed: Uint8List(32),
      allowPublicHttp: true,
      publicNode: true,
      publicIpConsent: true,
    );
    expect(rounds, 0);
  });

  test('an own node is saved, invalid text is rejected, and posts and reads use it', () async {
    expect(ownNodeUrlError(''), isNull);
    expect(parseOwnNodeUrl(''), isNull);
    expect(ownNodeSkipsPublicConsent(''), isFalse);
    expect(ownNodeUrlError('not a url'), kOwnNodeUrlError);
    expect(parseOwnNodeUrl('ftp://10.0.0.8:18332'), isNull);
    expect(parseOwnNodeUrl('https://p2p.shear.digital'), isNull);
    expect(parseOwnNodeUrl('http://'), isNull);
    expect(parseOwnNodeUrl('10.0.0.8:99999'), isNull);
    expect(parseOwnNodeUrl('192.168.1.9:18332'), 'http://192.168.1.9:18332');
    expect(parseOwnNodeUrl('https://mynode.example:8443/'), 'https://mynode.example:8443');
    expect(ownNodeSkipsPublicConsent('192.168.1.9:18332'), isTrue);

    final dir = Directory.systemTemp.createTempSync('own-node-session-');
    addTearDown(() {
      if (dir.existsSync()) dir.deleteSync(recursive: true);
    });
    final session = ShearSession(store: File('${dir.path}/session.json'));
    await session.loadOrCreate();
    await session.setPassword('test-pass-1');
    session.ownNodeUrl = parseOwnNodeUrl('10.1.1.8:18332')!;
    await session.persist();
    final again = ShearSession(store: session.store);
    await again.unlock('test-pass-1');
    expect(again.ownNodeUrl, 'http://10.1.1.8:18332');

    final server = await HttpServer.bind(InternetAddress.loopbackIPv4, 0);
    addTearDown(() => server.close(force: true));
    final hits = <String>[];
    server.listen((req) async {
      hits.add('${req.method} ${req.uri.path}');
      await req.drain<void>();
      req.response.headers.contentType = ContentType.json;
      req.response.write('{"ok":true,"height":2}');
      await req.response.close();
    });
    final http = _PassthroughHttpOverrides().createHttpClient(null);
    final client = ShearPoolClient(
      http: http,
      sync: ShearReadSync(
        seeds: ['http://127.0.0.1:${server.port}'],
        http: http,
        jitter: Duration.zero,
      ),
    );
    addTearDown(client.close);
    client.useOwnNode('127.0.0.1:${server.port}');
    expect(client.usesOwnNode, isTrue);
    expect(client.baseUrl, 'http://127.0.0.1:${server.port}');
    final stats = await client.stats();
    expect(stats['ok'], true);
    final posted = await client.send(from: 'ssa1from', to: 'ssa1to', amount: 1, kind: 'lock');
    expect(posted['ok'], true);
    expect(hits, contains('GET /stats'));
    expect(hits, contains('POST /api/wallet/send'));
    expect(hits.any((hit) => hit.contains('shear.digital')), isFalse);
    expect(() => client.useOwnNode('not a url'), throwsArgumentError);

    final bare = ShearPoolClient(
      http: http,
      sync: ShearReadSync(seeds: kPublicNodeSeeds, http: http, jitter: Duration.zero),
    );
    addTearDown(bare.close);
    bare.useOwnNode('10.0.0.8:18332');
    expect(bare.sync!.liveBase, 'http://10.0.0.8:18332');
    expect(creditFollowReadBase(bare), 'http://10.0.0.8:18332');
    expect(creditFollowReadSeeds(bare), ['http://10.0.0.8:18332']);
    bare.useOwnNode(null);
    expect(bare.usesOwnNode, isFalse);
    expect(bare.sync!.liveBase, isNull);
    expect(creditFollowReadSeeds(bare).any((s) => s.contains('shear.digital')), isTrue);
  });

  test('own-node URLs refuse public hosts, cleartext, and broken forms', () {
    expect(parseOwnNodeUrl('https://user:pass@mynode.example'), isNull);
    expect(parseOwnNodeUrl('https://mynode.example/rpc'), isNull);
    expect(parseOwnNodeUrl('https://mynode.example?x=1'), isNull);
    expect(parseOwnNodeUrl('[::1]:8080'), 'http://[::1]:8080');
    expect(parseOwnNodeUrl('http://[fd12::1]:8443'), 'http://[fd12::1]:8443');
    expect(parseOwnNodeUrl('http://[fe80::1]:18332'), 'http://[fe80::1]:18332');
    expect(parseOwnNodeUrl('p2p.shear.digital.'), isNull);
    expect(parseOwnNodeUrl('https://pool.shear.digital.:443'), isNull);
    expect(parseOwnNodeUrl('https://77.42.91.84'), isNull);
    expect(parseOwnNodeUrl('77.42.91.84.'), isNull);
    expect(parseOwnNodeUrl('http://1.2.3.4:18332'), isNull);
    expect(ownNodeSkipsPublicConsent('http://1.2.3.4:18332'), isFalse);
    expect(parseOwnNodeUrl('mynode.example:8443'), 'https://mynode.example:8443');
    expect(parseOwnNodeUrl('https://mynode.example:8443/'), 'https://mynode.example:8443');
    expect(rpcNeedsPublicIpWarning('http://127.0.0.1:18332'), isFalse);
    expect(rpcNeedsPublicIpWarning('http://192.168.1.9:18332'), isFalse);
    expect(rpcNeedsPublicIpWarning('https://p2p.shear.digital'), isTrue);
    expect(rpcNeedsPublicIpWarning('https://1.2.3.4:18332'), isTrue);
    final cli = File('lib/shear_cli.dart').readAsStringSync();
    expect('_warnPublicIp('.allMatches(cli).length, greaterThanOrEqualTo(4));
    expect(creditFollowProbesPublic(ownNode: true, base: ''), isFalse);
    expect(creditFollowProbesPublic(ownNode: false, base: 'http://10.0.0.8:18332'), isFalse);
    expect(creditFollowProbesPublic(ownNode: false, base: ''), isTrue);

    final client = ShearPoolClient();
    addTearDown(client.close);
    expect(() => client.useOwnNode('[::1]:8080'), returnsNormally);
    expect(client.baseUrl, 'http://[::1]:8080');
    expect(client.usesOwnNode, isTrue);
  });

  test('local down with no consent never dials a public host', () async {
    final saw = _Saw();
    final http = _SawClient(saw, fail: true);
    final client = ShearPoolClient(
      http: http,
      sync: ShearReadSync(seeds: [kLocalNodeRpc], http: http, jitter: Duration.zero),
    );
    addTearDown(client.close);
    await expectLater(
      client.send(from: 'ssa1from', to: 'ssa1to', amount: 1, kind: 'lock'),
      throwsA(isA<StateError>().having((e) => e.message, 'message', kLocalNodeDownCopy)),
    );
    await expectLater(
      client.history('ssa1from', viewKey: 'ab' * 32),
      throwsA(isA<StateError>().having((e) => e.message, 'message', kLocalNodeDownCopy)),
    );
    expect(saw.uris, isNotEmpty);
    for (final uri in saw.uris) {
      expect(uri.host.contains('shear.digital'), isFalse, reason: '$uri');
      expect(uri.host, isNot('77.42.91.84'), reason: '$uri');
    }
  });

  test('an own node does not poll the public pool or follow redirects', () async {
    final saw = _Saw();
    final http = _SawClient(saw);
    final client = ShearPoolClient(
      http: http,
      sync: ShearReadSync(seeds: kPublicNodeSeeds, http: http, jitter: Duration.zero),
    );
    addTearDown(client.close);
    client.useOwnNode('10.1.1.8:18332');
    var opened = false;
    final ledger = ShearLedger(pool: client);
    final changed = await ledger.readContinuityFigures(open: (base) {
      opened = true;
      throw StateError('leaked $base');
    });
    expect(changed, isFalse);
    expect(opened, isFalse);
    final stats = await client.stats();
    expect(stats['ok'], true);
    expect(saw.redirects, isNotEmpty);
    expect(saw.redirects.every((follow) => follow == false), isTrue);
    expect(saw.uris.every((u) => u.host == '10.1.1.8'), isTrue);

    final probe = _Saw();
    final probeHttp = _SawClient(probe, fail: true);
    final sync = ShearReadSync(
      http: probeHttp,
      seeds: ['https://p2p.shear.digital', 'https://pool.shear.digital'],
      jitter: Duration.zero,
    );
    sync.liveBase = 'http://10.1.1.8:18332';
    sync.blockPublicProbe = true;
    expect(await sync.findLiveNode(), 'http://10.1.1.8:18332');
    expect(probe.uris, isEmpty);
  });

  testWidgets('public Flow send asks, an own node does not, and a bad URL is rejected', (tester) async {
    tester.view.physicalSize = const Size(800, 2400);
    tester.view.devicePixelRatio = 1;
    addTearDown(tester.view.resetPhysicalSize);
    addTearDown(tester.view.resetDevicePixelRatio);

    final dir = Directory.systemTemp.createTempSync('flow-consent-ui-');
    addTearDown(() {
      if (dir.existsSync()) dir.deleteSync(recursive: true);
    });
    final session = ShearSession(store: File('${dir.path}/session.json'));
    await tester.runAsync(() async {
      await session.loadOrCreate();
      await session.setPassword('test-pass-1');
    });
    final ident = session.identity!;
    final ledger = ShearLedger()..bindIdentity(ident);
    ledger.viewSecret = ident.viewKey;
    final bobId = createIdentity();
    final bob = (ShearLedger()..bindIdentity(bobId)).homeDest(
      bobId.address,
      paymentCode: bobId.paymentCode,
    );
    await tester.pumpWidget(ShearWalletApp(
      session: session,
      ledger: ledger,
      startUnlocked: true,
      skipPoolSync: true,
    ));
    await tester.pump();
    await tester.pump();
    await tester.tap(find.text('Closure'));
    await tester.pump();
    await tester.ensureVisible(find.byKey(const Key('connect-own-node')));
    expect(find.text(kPublicNodeEverySendCopy), findsWidgets);
    await tester.enterText(find.byKey(const Key('connect-own-node')), 'not a url');
    await tester.tap(find.byKey(const Key('connect-own-node-save')));
    await tester.pump();
    expect(find.text(kOwnNodeUrlError), findsOneWidget);
    expect(session.ownNodeUrl, isEmpty);

    await tester.tap(find.text('Flow'));
    await tester.pump();
    await tester.enterText(find.widgetWithText(TextField, 'To (she1, ssa1, or shear1)'), bob);
    await tester.enterText(find.byKey(const Key('flow-amount')), '0.2');
    await tester.tap(find.byKey(const Key('flow-send')));
    await tester.pump();
    expect(find.byKey(const Key('reserve-unprivate-confirm')), findsOneWidget);
    expect(find.text(kPublicNodeEverySendCopy), findsWidgets);
    await tester.tap(find.byKey(const Key('reserve-unprivate-cancel')));
    await tester.pump();
    expect(find.text(kPublicIpWaitCopy), findsOneWidget);

    session.ownNodeUrl = 'http://127.0.0.1:18332';
    await tester.tap(find.byKey(const Key('flow-send')));
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 50));
    expect(find.byKey(const Key('reserve-unprivate-confirm')), findsNothing);
  });
}

/// Flutter's test binding stubs `HttpClient()` to HTTP 400.
class _PassthroughHttpOverrides extends HttpOverrides {}

class _Saw {
  final uris = <Uri>[];
  final redirects = <bool>[];
}

class _SawClient implements HttpClient {
  _SawClient(this.saw, {this.fail = false, this.body = '{"ok":true,"height":1}'});

  final _Saw saw;
  final bool fail;
  final String body;

  @override
  bool autoUncompress = true;
  @override
  Duration? connectionTimeout;
  @override
  Duration idleTimeout = const Duration(seconds: 15);
  @override
  int? maxConnectionsPerHost;
  @override
  String? userAgent;
  @override
  void addCredentials(Uri url, String realm, HttpClientCredentials credentials) {}
  @override
  void addProxyCredentials(String host, int port, String realm, HttpClientCredentials credentials) {}
  @override
  Future<ConnectionTask<Socket>> Function(Uri url, String? proxyHost, int? proxyPort)? connectionFactory;
  @override
  Future<bool> Function(Uri url, String scheme, String realm)? authenticate;
  @override
  Future<bool> Function(String host, int port, String scheme, String realm)? authenticateProxy;
  @override
  bool Function(X509Certificate cert, String host, int port)? badCertificateCallback;
  @override
  void Function(String line)? keyLog;
  @override
  void close({bool force = false}) {}
  @override
  String Function(Uri url)? findProxy;

  Future<HttpClientRequest> _req(Uri url) async => _SawRequest(url, saw, fail: fail, body: body);

  @override
  Future<HttpClientRequest> delete(String host, int port, String path) => _req(Uri());
  @override
  Future<HttpClientRequest> deleteUrl(Uri url) => _req(url);
  @override
  Future<HttpClientRequest> get(String host, int port, String path) => _req(Uri());
  @override
  Future<HttpClientRequest> getUrl(Uri url) {
    saw.uris.add(url);
    return _req(url);
  }

  @override
  Future<HttpClientRequest> head(String host, int port, String path) => _req(Uri());
  @override
  Future<HttpClientRequest> headUrl(Uri url) => _req(url);
  @override
  Future<HttpClientRequest> open(String method, String host, int port, String path) => _req(Uri());
  @override
  Future<HttpClientRequest> openUrl(String method, Uri url) => _req(url);
  @override
  Future<HttpClientRequest> patch(String host, int port, String path) => _req(Uri());
  @override
  Future<HttpClientRequest> patchUrl(Uri url) => _req(url);
  @override
  Future<HttpClientRequest> post(String host, int port, String path) => _req(Uri());
  @override
  Future<HttpClientRequest> postUrl(Uri url) {
    saw.uris.add(url);
    return _req(url);
  }

  @override
  Future<HttpClientRequest> put(String host, int port, String path) => _req(Uri());
  @override
  Future<HttpClientRequest> putUrl(Uri url) => _req(url);
}

class _SawRequest implements HttpClientRequest {
  _SawRequest(this.uri, this.saw, {required this.fail, required this.body});

  final _Saw saw;
  final bool fail;
  final String body;

  @override
  bool bufferOutput = true;
  @override
  int contentLength = -1;
  @override
  late Encoding encoding;
  @override
  bool followRedirects = true;
  @override
  final HttpHeaders headers = _SawHeaders();
  @override
  void add(List<int> data) {}
  @override
  void addError(Object error, [StackTrace? stackTrace]) {}
  @override
  Future<void> addStream(Stream<List<int>> stream) async {}
  @override
  Future<HttpClientResponse> close() async {
    saw.redirects.add(followRedirects);
    if (fail) throw const SocketException('down');
    return _SawResponse(body);
  }

  @override
  void abort([Object? exception, StackTrace? stackTrace]) {}
  @override
  HttpConnectionInfo? get connectionInfo => null;
  @override
  List<Cookie> get cookies => const [];
  @override
  Future<HttpClientResponse> get done async => _SawResponse(body);
  @override
  Future<void> flush() async {}
  @override
  int maxRedirects = 5;
  @override
  String get method => 'GET';
  @override
  bool persistentConnection = true;
  @override
  final Uri uri;
  @override
  void write(Object? obj) {}
  @override
  void writeAll(Iterable<dynamic> objects, [String separator = '']) {}
  @override
  void writeCharCode(int charCode) {}
  @override
  void writeln([Object? obj = '']) {}
}

class _SawResponse extends Stream<List<int>> implements HttpClientResponse {
  _SawResponse(String body) : _bytes = utf8.encode(body);

  final List<int> _bytes;

  @override
  StreamSubscription<List<int>> listen(
    void Function(List<int> event)? onData, {
    Function? onError,
    void Function()? onDone,
    bool? cancelOnError,
  }) {
    return Stream<List<int>>.value(_bytes).listen(
      onData,
      onError: onError,
      onDone: onDone,
      cancelOnError: cancelOnError,
    );
  }

  @override
  final HttpHeaders headers = _SawHeaders()..contentType = ContentType.json;
  @override
  int get statusCode => 200;
  @override
  int get contentLength => _bytes.length;
  @override
  X509Certificate? get certificate => null;
  @override
  HttpConnectionInfo? get connectionInfo => null;
  @override
  HttpClientResponseCompressionState get compressionState =>
      HttpClientResponseCompressionState.notCompressed;
  @override
  List<Cookie> get cookies => const [];
  @override
  Future<Socket> detachSocket() => Future<Socket>.error(UnsupportedError('saw'));
  @override
  bool get isRedirect => false;
  @override
  bool get persistentConnection => false;
  @override
  String get reasonPhrase => 'OK';
  @override
  Future<HttpClientResponse> redirect([String? method, Uri? url, bool? followLoops]) =>
      Future<HttpClientResponse>.error(UnsupportedError('saw'));
  @override
  List<RedirectInfo> get redirects => const [];
}

class _SawHeaders implements HttpHeaders {
  @override
  List<String>? operator [](String name) => const [];
  @override
  void add(String name, Object value, {bool preserveHeaderCase = false}) {}
  @override
  late bool chunkedTransferEncoding;
  @override
  void clear() {}
  @override
  int contentLength = -1;
  @override
  ContentType? contentType;
  @override
  DateTime? date;
  @override
  DateTime? expires;
  @override
  void forEach(void Function(String name, List<String> values) f) {}
  @override
  String? host;
  @override
  DateTime? ifModifiedSince;
  @override
  void noFolding(String name) {}
  @override
  late bool persistentConnection;
  @override
  int? port;
  @override
  void remove(String name, Object value) {}
  @override
  void removeAll(String name) {}
  @override
  void set(String name, Object value, {bool preserveHeaderCase = false}) {}
  @override
  String? value(String name) => null;
}
