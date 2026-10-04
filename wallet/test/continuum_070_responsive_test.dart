import 'dart:async';
import 'dart:convert';
import 'dart:io';
import 'dart:isolate';
import 'dart:typed_data';

import 'package:flutter/material.dart';
import 'package:flutter/scheduler.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:shear_wallet/main.dart';
import 'package:shear_wallet/shear_closure.dart';
import 'package:shear_wallet/shear_ledger.dart';
import 'package:shear_wallet/shear_read_open.dart';
import 'package:shear_wallet/shear_read_sync.dart';
import 'package:shear_wallet/shear_session.dart';
import 'package:shear_wallet/shear_theme.dart';

void main() {
  test('blockInfo returns the node block body off the UI isolate', () async {
    final ui = identityHashCode(Isolate.current).toString();
    final server = await HttpServer.bind(InternetAddress.loopbackIPv4, 0);
    addTearDown(() => server.close(force: true));
    server.listen((req) async {
      req.response.headers.contentType = ContentType.json;
      req.response.write(jsonEncode(_blockBody));
      await req.response.close();
    });
    final sync = ShearReadSync(
      seeds: ['http://127.0.0.1:${server.port}'],
      http: _RealHttpOverrides().createHttpClient(null)
        ..connectionTimeout = const Duration(seconds: 2),
      jitter: Duration.zero,
    );
    sync.liveBase = 'http://127.0.0.1:${server.port}';
    final got = await sync.blockInfo(7);
    expect(got, isNotNull);
    expect(got!['height'], 7);
    expect(got['header'], _blockBody['header']);
    expect(got['txs'], isA<List>());
    expect((got['txs'] as List), isNotEmpty);
    expect(debugNodeJsonOffIsolateStamp, isNotEmpty);
    expect(debugNodeJsonOffIsolateStamp, isNot(ui));
  });

  test('applyReadPageOffUi opens a block off the UI isolate', () async {
    final ui = identityHashCode(Isolate.current).toString();
    final sync = ShearReadSync(seeds: const ['http://127.0.0.1:9'], jitter: Duration.zero);
    final opened = await sync.applyReadPageOffUi(pageBlocks: [_blockBody], liveTip: 7);
    expect(opened.liveTip, 7);
    expect(debugReadProofOffIsolateStamp, isNotEmpty);
    expect(debugReadProofOffIsolateStamp, isNot(ui));
  });

  testWidgets('load, node log, block populate, and block info leave a frame free', (tester) async {
    final ui = identityHashCode(Isolate.current).toString();
    final dir = Directory.systemTemp.createTempSync('c070-ui-');
    addTearDown(() {
      if (dir.existsSync()) dir.deleteSync(recursive: true);
    });
    await tester.pumpWidget(const SizedBox());
    final store = File('${dir.path}/session.json');
    store.writeAsStringSync('   ');
    final session = ShearSession(store: store);
    var loadFrame = false;
    final load = tester.runAsync(() => session.loadOrCreate());
    tester.binding.addPostFrameCallback((_) => loadFrame = true);
    tester.binding.scheduleFrame();
    await tester.pump();
    expect(loadFrame, isTrue);
    await load.timeout(const Duration(seconds: 20));
    expect(debugSessionLoadStamp, isNotEmpty);
    expect(debugSessionLoadStamp, isNot(ui));
    expect(tester.takeException(), isNull);

    final live = ShearSession(store: File('${dir.path}/live.json'));
    await tester.runAsync(() async {
      await live.loadOrCreate();
      await live.setPassword('test-pass-1');
    }).timeout(const Duration(seconds: 40));
    final ledger = ShearLedger()..bindIdentity(live.identity!);
    await tester.pumpWidget(ShearWalletApp(
      session: live,
      ledger: ledger,
      startUnlocked: true,
      skipPoolSync: true,
      hostAndroid: true,
    ));
    await tester.pump();
    final state = tester.state<ShearWalletAppState>(find.byType(ShearWalletApp));
    final lines = <String>[
      'status height=6 peers=1 ibd=false magic=shear-testnet-v10',
      'status height=7 peers=0 ibd=false magic=shear-testnet-v10',
    ];
    var logFrame = false;
    final follow = tester.runAsync(() => state.followNodeLog(lines));
    tester.binding.addPostFrameCallback((_) => logFrame = true);
    tester.binding.scheduleFrame();
    await tester.pump();
    expect(logFrame, isTrue);
    await follow.timeout(const Duration(seconds: 20));
    expect(state.sidecar.reportedHeight, 7);
    expect(state.sidecar.reportedIbd, isFalse);
    expect(state.sidecar.log.join('\n'), contains('height=7'));
    expect(debugNodeLogOffIsolateStamp, isNotEmpty);
    expect(debugNodeLogOffIsolateStamp, isNot(ui));
    expect(tester.takeException(), isNull);

    final sync = ShearReadSync(
      seeds: const ['http://127.0.0.1:9'],
      http: _BlockClient(jsonEncode(_blockBody)),
      jitter: Duration.zero,
    );
    sync.liveBase = 'http://127.0.0.1:9';
    var infoFrame = false;
    final info = tester.runAsync(() => sync.blockInfo(7));
    tester.binding.addPostFrameCallback((_) => infoFrame = true);
    tester.binding.scheduleFrame();
    await tester.pump();
    expect(infoFrame, isTrue);
    final got = await info;
    expect(got, isNotNull);
    expect(got!['height'], 7);
    expect(got['header'], _blockBody['header']);
    expect(got['txs'], isA<List>());
    expect((got['txs'] as List), isNotEmpty);
    expect(debugNodeJsonOffIsolateStamp, isNotEmpty);
    expect(debugNodeJsonOffIsolateStamp, isNot(ui));
    expect(tester.takeException(), isNull);

    var popFrame = false;
    final pop = tester.runAsync(() => sync.applyReadPageOffUi(
          pageBlocks: [got],
          liveTip: 7,
        ));
    tester.binding.addPostFrameCallback((_) => popFrame = true);
    tester.binding.scheduleFrame();
    await tester.pump();
    expect(popFrame, isTrue);
    final opened = await pop;
    expect(opened, isNotNull);
    expect(opened!.liveTip, 7);
    expect(debugReadProofOffIsolateStamp, isNotEmpty);
    expect(debugReadProofOffIsolateStamp, isNot(ui));
    expect(tester.takeException(), isNull);
  }, timeout: const Timeout(Duration(seconds: 40)));

  testWidgets('unlock paints a responding shell before the credit read finishes', (tester) async {
    final gate = Completer<void>();
    addTearDown(() {
      if (!gate.isCompleted) gate.complete();
    });
    // Bind in the real zone. A listen() from the test body parks the notes
    // handler on a fake timer, so the credit await never finishes.
    final server = await tester.runAsync(() async {
      final bound = await HttpServer.bind(InternetAddress.loopbackIPv4, 0);
      bound.listen((req) async {
        if (req.uri.path.contains('notes')) {
          try {
            await gate.future.timeout(const Duration(seconds: 20));
          } catch (_) {}
        }
        req.response.headers.contentType = ContentType.json;
        final path = req.uri.path;
        if (path.contains('notes')) {
          req.response.write('{"ok":true,"notes":[]}');
        } else if (path.contains('balance')) {
          req.response.write('{"ok":true,"balance":0}');
        } else {
          req.response.write(
            '{"ok":true,"height":4,"magic":"shear-testnet-v10","network":"shear-testnet-v10"}',
          );
        }
        await req.response.close();
      });
      return bound;
    });
    expect(server, isNotNull);
    addTearDown(() => server!.close(force: true));
    final dir = Directory.systemTemp.createTempSync('c070-respond-');
    addTearDown(() {
      if (dir.existsSync()) dir.deleteSync(recursive: true);
    });
    final session = ShearSession(store: File('${dir.path}/session.json'));
    await tester.runAsync(() async {
      await session.loadOrCreate();
      await session.setPassword('test-pass-1');
    });
    final ledger = ShearLedger(
      pool: ShearPoolClient(baseUrl: 'http://127.0.0.1:${server!.port}'),
    );
    await tester.pumpWidget(ShearWalletApp(
      session: session,
      ledger: ledger,
      skipPoolSync: false,
      hostAndroid: true,
    ));
    await tester.pump();
    await tester.enterText(find.byType(TextField).first, 'test-pass-1');
    final state = tester.state<ShearWalletAppState>(find.byType(ShearWalletApp));
    // One runAsync. A second call is denied, and a fake timer never elapses
    // while this follow is still waiting on the notes gate.
    await tester.runAsync(() async {
      final unlock = state.unlockNow();
      final deadline = DateTime.now().add(const Duration(seconds: 20));
      while (!state.unlocked && DateTime.now().isBefore(deadline)) {
        await Future<void>.delayed(const Duration(milliseconds: 20));
      }
      expect(state.unlocked, isTrue);
      final binding = tester.binding;
      if (binding.hasScheduledFrame) {
        binding.handleBeginFrame(Duration.zero);
        binding.handleDrawFrame();
      }
      expect(find.byKey(const Key('continuum-spendable')), findsOneWidget);
      expect(tester.widget<Text>(find.byKey(const Key('continuum-spendable'))).data, '…');
      expect(find.byKey(const Key('wallet-block-height')), findsNothing);
      expect(find.byKey(const Key('continuum-empty-honesty')), findsNothing);
      expect(find.text('p2P Node'), findsNothing);
      expect(find.text('Full Node'), findsNothing);
      expect(find.byKey(const Key('android-banner-theme')), findsOneWidget);
      expect(debugCreditFollowRuns, 0);
      if (!gate.isCompleted) gate.complete();
      try {
        await unlock.timeout(const Duration(seconds: 15));
      } catch (_) {
        // A notes handler that missed the gate must not keep the follow open.
        await server!.close(force: true);
        await unlock.timeout(const Duration(seconds: 15));
      }
    });
    // Dispose before the post-frame accrual timer. A pump while the shell is
    // still mounted schedules that timer and the test ends with it pending.
    await tester.pumpWidget(const SizedBox.shrink());
    await tester.pump();
    expect(tester.takeException(), isNull);
  }, timeout: const Timeout(Duration(seconds: 60)));

  testWidgets('Android banner is dark and light, and the bar stays logo, link, height', (tester) async {
    tester.view.physicalSize = const Size(360, 640);
    tester.view.devicePixelRatio = 1;
    addTearDown(tester.view.resetPhysicalSize);
    addTearDown(tester.view.resetDevicePixelRatio);
    final dir = Directory.systemTemp.createTempSync('c070-banner-');
    addTearDown(() {
      if (dir.existsSync()) dir.deleteSync(recursive: true);
    });
    final session = ShearSession(store: File('${dir.path}/session.json'));
    await tester.runAsync(() async {
      await session.loadOrCreate();
      await session.setPassword('test-pass-1');
    });
    final ledger = ShearLedger()..bindIdentity(session.identity!);
    ledger.restoreSealedTip(12);
    await tester.pumpWidget(ShearWalletApp(
      session: session,
      ledger: ledger,
      startUnlocked: true,
      skipPoolSync: true,
      hostAndroid: true,
    ));
    await tester.pump();

    Color bannerOf() {
      final bar = tester.widget<AppBar>(find.byKey(const Key('android-top-banner')));
      return bar.backgroundColor!;
    }

    expect(find.byKey(const Key('wallet-connected')), findsOneWidget);
    expect(find.byKey(const Key('wallet-block-height')), findsOneWidget);
    expect(find.text('height 12'), findsOneWidget);
    expect(find.text('p2P Node'), findsNothing);
    expect(find.text('Full Node'), findsNothing);
    expect(bannerOf(), shearBar);

    await tester.tap(find.byKey(const Key('android-banner-theme')));
    await tester.pump();
    expect(tester.widget<MaterialApp>(find.byType(MaterialApp)).themeMode, ThemeMode.dark);
    expect(bannerOf(), shearDarkBar);
    expect(find.byKey(const Key('wallet-connected')), findsOneWidget);
    expect(find.text('height 12'), findsOneWidget);
    expect(find.text('p2P Node'), findsNothing);
    expect(find.text('Full Node'), findsNothing);

    await tester.tap(find.byKey(const Key('android-banner-theme')));
    await tester.pump();
    expect(tester.widget<MaterialApp>(find.byType(MaterialApp)).themeMode, ThemeMode.light);
    expect(bannerOf(), shearBar);
    expect(tester.takeException(), isNull);
  });
}

const _blockBody = <String, dynamic>{
  'ok': true,
  'height': 7,
  'hash': 'abc123',
  'header': '00112233445566778899aabbccddeeff',
  'txs': [
    {
      'vin': <Map<String, dynamic>>[],
      'vout': [
        {'kind': 'coinbase', 'commit': 'aa'},
      ],
    },
  ],
};

/// Widget tests install an [HttpClient] that answers 400 and never dials.
/// [createHttpClient] on a plain [HttpOverrides] is the real dart:io client,
/// which is what [ShearReadSync.blockInfo] uses on a device.
class _RealHttpOverrides extends HttpOverrides {}

/// Serves one block body through the [HttpClient] seam [ShearReadSync] already
/// takes. [getUrl] waits on a real timer so a frame can run during [blockInfo].
class _BlockClient implements HttpClient {
  _BlockClient(this.body);

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

  Future<HttpClientRequest> _req() {
    return Future<void>.delayed(const Duration(milliseconds: 80)).then((_) => _BlockRequest(body));
  }

  @override
  Future<HttpClientRequest> delete(String host, int port, String path) => _req();
  @override
  Future<HttpClientRequest> deleteUrl(Uri url) => _req();
  @override
  Future<HttpClientRequest> get(String host, int port, String path) => _req();
  @override
  Future<HttpClientRequest> getUrl(Uri url) => _req();
  @override
  Future<HttpClientRequest> head(String host, int port, String path) => _req();
  @override
  Future<HttpClientRequest> headUrl(Uri url) => _req();
  @override
  Future<HttpClientRequest> open(String method, String host, int port, String path) => _req();
  @override
  Future<HttpClientRequest> openUrl(String method, Uri url) => _req();
  @override
  Future<HttpClientRequest> patch(String host, int port, String path) => _req();
  @override
  Future<HttpClientRequest> patchUrl(Uri url) => _req();
  @override
  Future<HttpClientRequest> post(String host, int port, String path) => _req();
  @override
  Future<HttpClientRequest> postUrl(Uri url) => _req();
  @override
  Future<HttpClientRequest> put(String host, int port, String path) => _req();
  @override
  Future<HttpClientRequest> putUrl(Uri url) => _req();
}

class _BlockRequest implements HttpClientRequest {
  _BlockRequest(this.body);

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
  final HttpHeaders headers = _BlockHeaders();
  @override
  void add(List<int> data) {}
  @override
  void addError(Object error, [StackTrace? stackTrace]) {}
  @override
  Future<void> addStream(Stream<List<int>> stream) async {}
  @override
  Future<HttpClientResponse> close() async => _BlockResponse(body);
  @override
  void abort([Object? exception, StackTrace? stackTrace]) {}
  @override
  HttpConnectionInfo? get connectionInfo => null;
  @override
  List<Cookie> get cookies => const [];
  @override
  Future<HttpClientResponse> get done async => _BlockResponse(body);
  @override
  Future<void> flush() async {}
  @override
  int maxRedirects = 5;
  @override
  String get method => 'GET';
  @override
  bool persistentConnection = true;
  @override
  Uri get uri => Uri();
  @override
  void write(Object? obj) {}
  @override
  void writeAll(Iterable<dynamic> objects, [String separator = '']) {}
  @override
  void writeCharCode(int charCode) {}
  @override
  void writeln([Object? obj = '']) {}
}

class _BlockResponse extends Stream<List<int>> implements HttpClientResponse {
  _BlockResponse(String body) : _bytes = utf8.encode(body);

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
  final HttpHeaders headers = _BlockHeaders()..contentType = ContentType.json;
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
  Future<Socket> detachSocket() => Future<Socket>.error(UnsupportedError('block'));
  @override
  bool get isRedirect => false;
  @override
  bool get persistentConnection => false;
  @override
  String get reasonPhrase => 'OK';
  @override
  Future<HttpClientResponse> redirect([String? method, Uri? url, bool? followLoops]) =>
      Future<HttpClientResponse>.error(UnsupportedError('block'));
  @override
  List<RedirectInfo> get redirects => const [];
}

class _BlockHeaders implements HttpHeaders {
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
