import 'dart:async';
import 'dart:convert';
import 'dart:io';
import 'dart:isolate';

import 'package:flutter_test/flutter_test.dart';
import 'package:shear_wallet/shear_cli.dart';
import 'package:shear_wallet/shear_closure.dart';
import 'package:shear_wallet/shear_identity.dart';
import 'package:shear_wallet/shear_ledger.dart';
import 'package:shear_wallet/shear_session.dart';
import 'package:shear_wallet/shear_public_confirm.dart';
import 'package:shear_wallet/shear_read_sync.dart';
import 'package:shear_wallet/shear_tip_tick.dart';

void main() {
  test('the wallet entries arm the dial, and a load does not', () async {
    final confirm = File('lib/shear_public_confirm.dart').readAsStringSync();
    expect(confirm.contains('walletConnectReady'), isFalse);
    expect(File('lib/main.dart').readAsStringSync(), contains('armWalletConnect()'));
    expect(File('bin/shear.dart').readAsStringSync(), contains('armWalletConnect()'));
    expect(File('lib/shear_cli.dart').readAsStringSync(), contains('armWalletConnect()'));
    final ledgerSrc = File('lib/shear_ledger.dart').readAsStringSync();
    expect(ledgerSrc, contains('armWalletConnect()'));

    final code = await runShearCli(['help']);
    expect(code, 0);
    expect(walletConnect, isNotNull);
    final client = ShearPoolClient();
    final syncHttp = HttpClient();
    final sync = ShearReadSync(
      http: syncHttp,
      seeds: const ['http://127.0.0.1:9'],
      jitter: Duration.zero,
    );
    addTearDown(client.close);
    addTearDown(() => syncHttp.close(force: true));
    expect(client.debugConnectPinned, isTrue);
    expect(sync.debugConnectPinned, isTrue);

    final recv = ReceivePort();
    addTearDown(recv.close);
    await Isolate.spawn(creditFollowEntry, <dynamic>[
      jsonEncode({
        'chain': false,
        'full': false,
        'spendableFirst': false,
        'baseUrl': '',
        'publicConsent': false,
      }),
      recv.sendPort,
    ]);
    final msg = await recv.first.timeout(const Duration(seconds: 30));
    expect(msg, isA<Map>());
    expect((msg as Map)['connectPinned'], isTrue);
  });

  test('local node copy says who sees the IP', () {
    expect(kLocalNodeIpCopy, contains('Only your own node and its P2P peers see your IP'));
    expect(kLocalNodeIpCopy, contains('syncs over P2P only'));
    expect(kLocalNodeIpCopy.contains('seed hosts'), isFalse);
    expect(kLocalNodeIpCopy, contains('The public node never gets your view key or your sends.'));
    expect(kLocalNodeModeCopy, contains('Only your own node and its P2P peers see your IP'));
    expect(kLocalNodeFullModeCopy, contains('Only your own node and its P2P peers see your IP'));
    expect(kLocalNodeModeCopy.contains('seed hosts'), isFalse);
    expect(kLocalNodeFullModeCopy.contains('seed hosts'), isFalse);
    expect(kLocalNodeModeCopy.contains('Best privacy'), isFalse);
    expect(kLocalNodeFullModeCopy.contains('Best privacy'), isFalse);
    final ui = File('lib/main.dart').readAsStringSync();
    final closure = File('lib/shear_closure.dart').readAsStringSync();
    expect(ui.contains('Best privacy'), isFalse);
    expect(ui.contains('Nothing is sent to a public node'), isFalse);
    expect(closure.contains('Best privacy'), isFalse);
    expect(ui, contains('kLocalNodeIpCopy'));
  });

  test('a P2P spawn carries a fresh token and loopback binds', () async {
    Map<String, String>? env;
    final side = ShearNodeSidecar(
      nodeBinary: 'node',
      startProcess: (binary, got, args) async {
        env = got;
      },
    );
    side.select(ClosureSendMode.localNode);
    await side.apply();
    final token = env!['SHEAR_RPC_TOKEN']!;
    expect(token.length, 64);
    expect(token, isNot(contains(' ')));
    expect(env!['SHEAR_P2P_BIND'], '127.0.0.1');
    expect(env!['SHEAR_STRATUM_BIND'], '127.0.0.1');
    expect(env!['SHEAR_RPC_BIND'], '127.0.0.1');
    expect(env!['SHEAR_HTTP_FOLLOW'], '0');
    expect(localRpcToken, token);
    expect(localRpcPort, 18332);
    side.select(ClosureSendMode.localNodeFull);
    await side.apply();
    expect(env!['SHEAR_RPC_TOKEN'], isNot(token));
    expect(env!['SHEAR_RPC_TOKEN']!.length, 64);
    expect(localRpcToken, env!['SHEAR_RPC_TOKEN']);
    side.select(ClosureSendMode.connectBare);
    await side.apply();
    expect(localRpcToken, isNull);
    expect(localRpcPort, isNull);
    var calls = 0;
    final bare = ShearNodeSidecar(
      nodeBinary: 'node',
      startProcess: (binary, got, args) async {
        calls += 1;
      },
    );
    expect(await bare.startDesktopBook(), kConnectBareCopy);
    expect(calls, 0);
    expect(bare.running, isFalse);
  });

  test('an injected client still answers after a revoke', () async {
    final http = _CountingClient();
    final client = ShearPoolClient(http: http, baseUrl: 'http://127.0.0.1:9');
    client.publicConsent = true;
    client.stopPublicReads();
    expect(http.closes, 0);
    expect(client.publicConsent, isFalse);
    final stats = await client.stats();
    expect(stats['ok'], true);
    expect(stats['height'], 5);
    expect(http.closes, 0);
    expect(http.gets, greaterThan(0));
  });

  test('a host aliased to the public node is refused, and the next address is used', () async {
    final previous = HttpOverrides.current;
    HttpOverrides.global = _RealHttp();
    addTearDown(() => HttpOverrides.global = previous);
    final lookup = ownNodeLookup;
    addTearDown(() => ownNodeLookup = lookup);
    armWalletConnect();

    ownNodeLookup = (host) async {
      if (host == 'alias.example') return [InternetAddress('77.42.91.84')];
      throw const SocketException('dns');
    };
    final aliased = ShearPoolClient(baseUrl: 'https://alias.example');
    addTearDown(aliased.close);
    aliased.debugHttp.findProxy = (_) => 'DIRECT';
    await expectLater(
      aliased.stats(),
      throwsA(isA<SocketException>().having((e) => e.message, 'message', 'public node refused')),
    );

    final server = await HttpServer.bind(InternetAddress.loopbackIPv4, 0);
    addTearDown(() => server.close(force: true));
    server.listen((req) async {
      req.response.headers.contentType = ContentType.json;
      req.response.write('{"ok":true,"height":4}');
      await req.response.close();
    });
    ownNodeLookup = (host) async {
      if (host == 'multi.example') {
        return [InternetAddress('127.0.0.2'), InternetAddress('127.0.0.1')];
      }
      throw const SocketException('dns');
    };
    final multi = ShearPoolClient(baseUrl: 'http://multi.example:${server.port}');
    addTearDown(multi.close);
    multi.debugHttp.findProxy = (_) => 'DIRECT';
    final stats = await multi.stats();
    expect(stats['ok'], true);
    expect(stats['height'], 4);
  });

  test('a configured proxy is used, and a refused proxy is not dialled', () async {
    final previous = HttpOverrides.current;
    HttpOverrides.global = _RealHttp();
    addTearDown(() => HttpOverrides.global = previous);
    final lookup = ownNodeLookup;
    addTearDown(() => ownNodeLookup = lookup);
    armWalletConnect();

    var targetHits = 0;
    final target = await HttpServer.bind(InternetAddress.loopbackIPv4, 0);
    addTearDown(() => target.close(force: true));
    target.listen((req) async {
      targetHits += 1;
      req.response.statusCode = 500;
      await req.response.close();
    });
    final proxy = await ServerSocket.bind(InternetAddress.loopbackIPv4, 0);
    addTearDown(() => proxy.close());
    var proxyHeads = 0;
    proxy.listen((socket) {
      final chunks = <int>[];
      socket.listen((data) {
        chunks.addAll(data);
        final text = utf8.decode(chunks, allowMalformed: true);
        if (!text.contains('\r\n\r\n')) return;
        proxyHeads += 1;
        final body = '{"ok":true,"height":7}';
        socket.add(utf8.encode(
          'HTTP/1.1 200 OK\r\n'
          'Content-Type: application/json\r\n'
          'Content-Length: ${body.length}\r\n'
          'Connection: close\r\n'
          '\r\n'
          '$body',
        ));
        socket.close();
      });
    });
    ownNodeLookup = (host) async {
      if (host == 'target.example') return [InternetAddress('127.0.0.1')];
      if (host == 'bad.proxy') return [InternetAddress('77.42.91.84')];
      throw const SocketException('dns');
    };
    final client = ShearPoolClient(baseUrl: 'http://target.example:${target.port}');
    addTearDown(client.close);
    client.debugHttp.findProxy = (_) => 'PROXY 127.0.0.1:${proxy.port}';
    final stats = await client.stats();
    expect(stats['height'], 7);
    expect(proxyHeads, greaterThan(0));
    expect(targetHits, 0);

    client.debugHttp.findProxy = (_) => 'PROXY bad.proxy:8080';
    final before = targetHits;
    await expectLater(
      client.stats(),
      throwsA(isA<SocketException>().having((e) => e.message, 'message', 'public node refused')),
    );
    expect(targetHits, before);
  });

  test('a bad certificate callback does not accept the sidecar TLS', () async {
    final openssl = await Process.run('openssl', ['version']);
    expect(openssl.exitCode, 0, reason: 'openssl ${openssl.stderr}');
    final dir = Directory.systemTemp.createTempSync('pin-tls-');
    addTearDown(() {
      if (dir.existsSync()) dir.deleteSync(recursive: true);
    });
    final cert = '${dir.path}/cert.pem';
    final key = '${dir.path}/key.pem';
    final made = await Process.run('openssl', [
      'req',
      '-x509',
      '-newkey',
      'rsa:2048',
      '-keyout',
      key,
      '-out',
      cert,
      '-days',
      '1',
      '-nodes',
      '-subj',
      '/CN=127.0.0.1',
    ]);
    expect(made.exitCode, 0, reason: '${made.stderr}');
    final context = SecurityContext()
      ..useCertificateChain(cert)
      ..usePrivateKey(key);
    final server = await HttpServer.bindSecure(InternetAddress.loopbackIPv4, 0, context);
    addTearDown(() => server.close(force: true));
    var hits = 0;
    server.listen((req) async {
      hits += 1;
      req.response.write('{"ok":true,"height":1}');
      await req.response.close();
    });
    final previous = HttpOverrides.current;
    HttpOverrides.global = _RealHttp();
    addTearDown(() => HttpOverrides.global = previous);
    armWalletConnect();
    final client = ShearPoolClient(baseUrl: 'https://127.0.0.1:${server.port}');
    addTearDown(client.close);
    client.debugHttp.findProxy = (_) => 'DIRECT';
    client.debugHttp.badCertificateCallback = (cert, host, port) => true;
    await expectLater(
      client.stats(),
      throwsA(predicate((Object e) {
        final text = e.toString().toLowerCase();
        return text.contains('handshake') || text.contains('certificate');
      })),
    );
    expect(hits, 0);
  });

  test('requests after a revoke work on a client the pool owns', () async {
    final previous = HttpOverrides.current;
    HttpOverrides.global = _RealHttp();
    addTearDown(() => HttpOverrides.global = previous);
    armWalletConnect();
    final server = await HttpServer.bind(InternetAddress.loopbackIPv4, 0);
    addTearDown(() => server.close(force: true));
    server.listen((req) async {
      req.response.headers.contentType = ContentType.json;
      req.response.write('{"ok":true,"height":3}');
      await req.response.close();
    });
    final client = ShearPoolClient(baseUrl: 'http://127.0.0.1:${server.port}');
    addTearDown(client.close);
    client.publicConsent = true;
    client.publicConsent = false;
    client.debugHttp.findProxy = (_) => 'DIRECT';
    final stats = await client.stats();
    expect(stats['ok'], true);
    expect(stats['height'], 3);
    expect(client.debugConnectPinned, isTrue);
  });

  test('a shear.digital name is refused before DNS unless consent applies', () async {
    final lookup = ownNodeLookup;
    addTearDown(() => ownNodeLookup = lookup);
    var lookups = 0;
    ownNodeLookup = (host) async {
      lookups += 1;
      throw const SocketException('dns');
    };
    await expectLater(
      walletConnectTask(Uri.parse('https://cdn.shear.digital/book'), allowPublic: false),
      throwsA(isA<SocketException>().having((e) => e.message, 'message', 'public node refused')),
    );
    await expectLater(
      walletConnectTask(Uri.parse('https://77.42.91.84/book'), allowPublic: false),
      throwsA(isA<SocketException>().having((e) => e.message, 'message', 'public node refused')),
    );
    expect(lookups, 0);
    await expectLater(
      walletConnectTask(Uri.parse('https://cdn.shear.digital/book'), allowPublic: true),
      throwsA(isA<SocketException>().having((e) => e.message, 'message', 'dns failed')),
    );
    expect(lookups, 1);
  });

  test('the CLI token stays in memory and is sent only to the node port', () async {
    final previousToken = localRpcToken;
    final previousPort = localRpcPort;
    addTearDown(() {
      localRpcToken = previousToken;
      localRpcPort = previousPort;
    });
    const token = 'desk-token-secret';
    final code = await runShearCli(['help'], env: {
      'SHEAR_RPC_TOKEN': token,
      'SHEAR_RPC_PORT': '18332',
    });
    expect(code, 0);
    expect(localRpcToken, token);
    expect(localRpcPort, 18332);
    final dir = Directory.systemTemp.createTempSync('cli-token-');
    addTearDown(() {
      if (dir.existsSync()) dir.deleteSync(recursive: true);
    });
    final session = ShearSession(store: File('${dir.path}/session.json'));
    await session.loadOrCreate();
    await session.setPassword('test-pass-1');
    await session.persist();
    expect(session.store.readAsStringSync().contains(token), isFalse);

    final previous = HttpOverrides.current;
    HttpOverrides.global = _RealHttp();
    addTearDown(() => HttpOverrides.global = previous);
    final seen = <int, String?>{};
    final nodePort = await HttpServer.bind(InternetAddress.loopbackIPv4, 0);
    final otherPort = await HttpServer.bind(InternetAddress.loopbackIPv4, 0);
    addTearDown(() => nodePort.close(force: true));
    addTearDown(() => otherPort.close(force: true));
    for (final server in [nodePort, otherPort]) {
      server.listen((req) async {
        seen[server.port] = req.headers.value(kLocalRpcTokenHeader);
        req.response.headers.contentType = ContentType.json;
        req.response.write('{"ok":true,"height":1}');
        await req.response.close();
      });
    }
    armLocalRpcFromEnv({'SHEAR_RPC_TOKEN': token, 'SHEAR_RPC_PORT': '${nodePort.port}'});
    final node = ShearPoolClient(baseUrl: 'http://127.0.0.1:${nodePort.port}');
    final other = ShearPoolClient(baseUrl: 'http://127.0.0.1:${otherPort.port}');
    addTearDown(node.close);
    addTearDown(other.close);
    node.debugHttp.findProxy = (_) => 'DIRECT';
    other.debugHttp.findProxy = (_) => 'DIRECT';
    expect((await node.stats())['height'], 1);
    expect(seen[nodePort.port], token);
    expect((await other.stats())['height'], 1);
    expect(seen[otherPort.port], isNull);
  });

  test('a credit worker loads balance and spendable from a token-locked node', () async {
    final previousToken = localRpcToken;
    final previousPort = localRpcPort;
    addTearDown(() {
      localRpcToken = previousToken;
      localRpcPort = previousPort;
    });
    localRpcToken = null;
    localRpcPort = null;
    const token = 'worker-rpc-token';
    final seen = <String>[];
    final server = await HttpServer.bind(InternetAddress.loopbackIPv4, 0);
    addTearDown(() => server.close(force: true));
    server.listen((req) async {
      final got = req.headers.value(kLocalRpcTokenHeader);
      seen.add('${req.uri.path}|$got');
      req.response.headers.contentType = ContentType.json;
      if (got != token) {
        req.response.statusCode = 403;
        req.response.write('{"ok":false,"reason":"rpc_token"}');
        await req.response.close();
        return;
      }
      final path = req.uri.path;
      if (path == '/stats' || path == '/api/stats') {
        req.response.write('{"ok":true,"height":4}');
      } else if (path.contains('balance')) {
        req.response.write('{"ok":true,"balance":999.5}');
      } else if (path.contains('notes')) {
        req.response.write('{"ok":true,"notes":[]}');
      } else {
        req.response.statusCode = 404;
        req.response.write('{"ok":false}');
      }
      await req.response.close();
    });

    final id = createIdentity();
    final recv = ReceivePort();
    addTearDown(recv.close);
    await Isolate.spawn(creditFollowEntry, <dynamic>[
      jsonEncode({
        'full': false,
        'chain': false,
        'spendableFirst': true,
        'baseUrl': 'http://127.0.0.1:${server.port}',
        'ownNode': false,
        'publicConsent': false,
        'address': id.address,
        'seedHex': id.seedHex,
        'viewKey': id.viewKey,
        'paymentCode': id.paymentCode,
        'restFrame': id.address,
        'rpcToken': token,
        'rpcPort': server.port,
      }),
      recv.sendPort,
    ]);
    final msg = await recv.first.timeout(const Duration(seconds: 30)) as Map;
    expect(msg['event'], 'done', reason: '${msg['message']}');
    final out = Map<String, dynamic>.from(msg['out'] as Map);
    expect(out.containsKey('rpcToken'), isFalse);
    expect(jsonEncode(out).contains(token), isFalse);
    expect((out['opened'] as num).toDouble(), 0);
    expect(jsonEncode(out['spendable']).contains('999.5'), isFalse);
    expect(seen.any((s) => (s.startsWith('/stats|') || s.startsWith('/api/stats|')) && s.endsWith(token)), isTrue);
    expect(seen.any((s) => s.contains('balance') && s.endsWith(token)), isTrue);
    expect(seen.any((s) => s.contains('notes') && s.endsWith(token)), isTrue);
    expect(localRpcToken, isNull);

    localRpcToken = token;
    localRpcPort = server.port;
    final ledger = ShearLedger(pool: ShearPoolClient(baseUrl: 'http://127.0.0.1:${server.port}'));
    addTearDown(() => ledger.pool?.close());
    ledger.bindIdentity(id);
    final opened = await ledger.followOffUi(
      restFrame: id.address,
      paymentCode: id.paymentCode,
      full: false,
      spendableFirst: true,
    );
    expect(debugLastFollowSpecKeys, contains('rpcToken'));
    expect(opened, 0);
    expect(ledger.spendableOwned(id.address, paymentCode: id.paymentCode), 0);
    final exported = ledger.exportCreditFollow(
      restFrame: id.address,
      paymentCode: id.paymentCode,
      full: false,
    );
    expect(exported.containsKey('rpcToken'), isFalse);
    expect(jsonEncode(exported).contains(token), isFalse);
    expect(jsonEncode(exported['spendable']).contains('999.5'), isFalse);
  });
}

class _RealHttp extends HttpOverrides {}

class _CountingClient implements HttpClient {
  int closes = 0;
  int gets = 0;

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
  void close({bool force = false}) {
    closes += 1;
  }

  @override
  String Function(Uri url)? findProxy;

  @override
  Future<HttpClientRequest> delete(String host, int port, String path) => getUrl(Uri());
  @override
  Future<HttpClientRequest> deleteUrl(Uri url) => getUrl(url);
  @override
  Future<HttpClientRequest> get(String host, int port, String path) => getUrl(Uri());
  @override
  Future<HttpClientRequest> getUrl(Uri url) async {
    gets += 1;
    return _CountingRequest();
  }

  @override
  Future<HttpClientRequest> head(String host, int port, String path) => getUrl(Uri());
  @override
  Future<HttpClientRequest> headUrl(Uri url) => getUrl(url);
  @override
  Future<HttpClientRequest> open(String method, String host, int port, String path) => getUrl(Uri());
  @override
  Future<HttpClientRequest> openUrl(String method, Uri url) => getUrl(url);
  @override
  Future<HttpClientRequest> patch(String host, int port, String path) => getUrl(Uri());
  @override
  Future<HttpClientRequest> patchUrl(Uri url) => getUrl(url);
  @override
  Future<HttpClientRequest> post(String host, int port, String path) => getUrl(Uri());
  @override
  Future<HttpClientRequest> postUrl(Uri url) => getUrl(url);
  @override
  Future<HttpClientRequest> put(String host, int port, String path) => getUrl(Uri());
  @override
  Future<HttpClientRequest> putUrl(Uri url) => getUrl(url);
}

class _CountingRequest implements HttpClientRequest {
  @override
  bool bufferOutput = true;
  @override
  int contentLength = -1;
  @override
  late Encoding encoding;
  @override
  bool followRedirects = true;
  @override
  final HttpHeaders headers = _CountingHeaders();
  @override
  void add(List<int> data) {}
  @override
  void addError(Object error, [StackTrace? stackTrace]) {}
  @override
  Future<void> addStream(Stream<List<int>> stream) async {}
  @override
  Future<HttpClientResponse> close() async => _CountingResponse();
  @override
  void abort([Object? exception, StackTrace? stackTrace]) {}
  @override
  HttpConnectionInfo? get connectionInfo => null;
  @override
  List<Cookie> get cookies => const [];
  @override
  Future<HttpClientResponse> get done async => _CountingResponse();
  @override
  Future<void> flush() async {}
  @override
  int maxRedirects = 5;
  @override
  String get method => 'GET';
  @override
  bool persistentConnection = true;
  @override
  Uri get uri => Uri.parse('http://127.0.0.1:9/stats');
  @override
  void write(Object? obj) {}
  @override
  void writeAll(Iterable<dynamic> objects, [String separator = '']) {}
  @override
  void writeCharCode(int charCode) {}
  @override
  void writeln([Object? obj = '']) {}
}

class _CountingResponse extends Stream<List<int>> implements HttpClientResponse {
  _CountingResponse() : _bytes = utf8.encode('{"ok":true,"height":5}');

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
  final HttpHeaders headers = _CountingHeaders()..contentType = ContentType.json;
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
  Future<Socket> detachSocket() => Future<Socket>.error(UnsupportedError('count'));
  @override
  bool get isRedirect => false;
  @override
  bool get persistentConnection => false;
  @override
  String get reasonPhrase => 'OK';
  @override
  Future<HttpClientResponse> redirect([String? method, Uri? url, bool? followLoops]) =>
      Future<HttpClientResponse>.error(UnsupportedError('count'));
  @override
  List<RedirectInfo> get redirects => const [];
}

class _CountingHeaders implements HttpHeaders {
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
