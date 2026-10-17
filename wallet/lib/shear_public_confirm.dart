/// Consent before a public-node post. There is no Tor path.
///
/// A public-node post is refused until the user accepts [kUnprivateConfirmLabel].
/// An own node on https, or on http to this machine or the LAN, does not ask.
import 'dart:io';

import 'shear_read_sync.dart';
import 'shear_tip_tick.dart';

const kUnprivateConfirmTitle = 'Public node may see your IP';

const kUnprivateConfirmLabel = 'I already use a VPN / I accept exposing my IP';

/// Connect bare consent, settings, docs, and wallet help share this sentence.
const kPublicNodeEverySendCopy =
    'The public node can see your IP on every send and every sync, not just once. '
    'In public mode, history requests carry your view key, so that operator can see incoming payments. '
    'Use a VPN, or point Continuum at your own node. '
    'A full node keeps your IP from the public node; your node\'s peers still see your IP.';

const kUnprivateConfirmHelper = kPublicNodeEverySendCopy;

const kUnprivateUnlockedBanner =
    'Unprivate send unlocked — public node may see your IP unless you already use a VPN';

/// The wait line is the same sentence as the confirm. There is no shorter variant.
const kPublicIpWaitCopy = kPublicNodeEverySendCopy;

const kOwnNodeUrlError =
    'Not a node URL. Use host:port or https://host:port. '
    'http is only for this machine, a private IP, or a .local name. '
    'Own node means a node you run, not a public Shear host. '
    'A name or address that reaches a public Shear node is still the public node.';

/// DNS failed. The saved own node stays; it is not used until a later check passes.
const kOwnNodeUnresolvedCopy =
    'That own node is saved, and it is not used until its name resolves. '
    'An address that reaches a public Shear node is still refused.';

const kLocalNodeDownCopy = 'local node not running';

/// Standing Reserve note on Connect bare.
const kReserveIpDisclaimer =
    'Connect bare sends this deposit to the public node directly. A tunnel is not required. '
    '$kPublicNodeEverySendCopy';

String publicIpWaitCopy({required bool accepted}) =>
    accepted ? kUnprivateUnlockedBanner : kPublicIpWaitCopy;

/// Any finite positive SHE amount. No magnitude ceiling.
bool unprivateAmountPermitted(double she) => she.isFinite && she > 0;

/// Lock, vote, withdraw, and Flow may post to the public node only after this confirm.
bool publicNodePostAllowed({required bool consent}) => consent;

/// Adds http:// when the operator omitted the scheme, same as an own-node host.
String normalizeWalletRpc(String raw) {
  var s = raw.trim();
  if (s.isEmpty) return s;
  if (!s.contains('://')) s = 'http://$s';
  return s;
}

/// True when [rpc] is not loopback, a private IP, link-local, IPv6 ULA, or `.local`.
bool rpcNeedsPublicIpWarning(String rpc) {
  final u = Uri.tryParse(normalizeWalletRpc(rpc));
  if (u == null || u.host.isEmpty) return true;
  if (isPublicWalletHost(u.host)) return true;
  return !ownNodeAllowsHttp(u.host);
}

/// A public RPC post is allowed only when the operator passed --public-ok.
bool cliAllowsPublicPost({required String rpc, required bool publicOk}) =>
    publicOk && rpcNeedsPublicIpWarning(rpc);

/// DNS lookup used when an own node is saved or connected. Tests replace this.
typedef OwnNodeLookup = Future<List<InternetAddress>> Function(String host);
OwnNodeLookup ownNodeLookup = InternetAddress.lookup;

class OwnNodeCheck {
  const OwnNodeCheck({this.url, this.dnsFailed = false});

  final String? url;

  /// Lookup failed or returned nothing. [url] is null and the saved value stays.
  final bool dnsFailed;

  bool get ok => url != null;
}

/// Parse, then refuse a host that resolves to a public Shear address.
/// http is kept only when every resolved address is loopback or RFC1918.
Future<OwnNodeCheck> checkOwnNodeUrl(String raw) async {
  final parsed = parseOwnNodeUrl(raw);
  if (parsed == null) return const OwnNodeCheck();
  final uri = Uri.parse(parsed);
  List<InternetAddress> addrs;
  try {
    addrs = await ownNodeLookup(uri.host);
  } catch (_) {
    return const OwnNodeCheck(dnsFailed: true);
  }
  if (addrs.isEmpty) return const OwnNodeCheck(dnsFailed: true);
  for (final addr in addrs) {
    final canon = ipv4OfAddress(addr) ?? addr.address;
    if (hostIsUnspecified(canon) || isPublicWalletHost(canon)) return const OwnNodeCheck();
    if (uri.scheme == 'http' && !ownNodeAllowsHttp(canon) && !addr.isLoopback) {
      return const OwnNodeCheck();
    }
  }
  return OwnNodeCheck(url: parsed);
}

Future<String?> acceptOwnNodeUrl(String raw) async => (await checkOwnNodeUrl(raw)).url;

/// True when [origin] is a public Shear name or resolves to a refused address.
Future<bool> vorticeOriginIsPublic(String origin) async {
  if (isPublicWalletHost(origin)) return true;
  final host = Uri.tryParse(origin)?.host ?? '';
  if (host.isEmpty) return true;
  final literal = InternetAddress.tryParse(host);
  List<InternetAddress> addrs;
  if (literal != null) {
    addrs = [literal];
  } else {
    try {
      addrs = await ownNodeLookup(host);
    } catch (_) {
      return true;
    }
  }
  if (addrs.isEmpty) return true;
  for (final addr in addrs) {
    final canon = ipv4OfAddress(addr) ?? addr.address;
    if (hostIsUnspecified(canon) || isPublicWalletHost(canon)) return true;
  }
  return false;
}

/// Dial [uri] at the address resolved now. SNI and Host stay [uri.host].
Future<ConnectionTask<Socket>> walletConnectTask(Uri uri, {required bool allowPublic}) async {
  final host = uri.host;
  final port = uri.hasPort ? uri.port : (uri.scheme == 'https' ? 443 : 80);
  if (host.isEmpty || host.contains('%')) {
    throw SocketException('refused host', port: port);
  }
  final literal = InternetAddress.tryParse(host);
  final List<InternetAddress> addrs;
  if (literal != null) {
    addrs = [literal];
  } else {
    try {
      addrs = await ownNodeLookup(host);
    } catch (_) {
      throw SocketException('dns failed', port: port);
    }
  }
  if (addrs.isEmpty) throw SocketException('dns failed', port: port);
  InternetAddress? chosen;
  for (final addr in addrs) {
    final canon = ipv4OfAddress(addr) ?? addr.address;
    if (hostIsUnspecified(canon)) throw const SocketException('unspecified address');
    if (isPublicWalletHost(canon) && !allowPublic) {
      throw const SocketException('public node refused');
    }
    if (uri.scheme == 'http' && !ownNodeAllowsHttp(canon) && !addr.isLoopback) {
      throw const SocketException('cleartext refused');
    }
    chosen ??= addr;
  }
  final addr = chosen!;
  if (uri.scheme == 'https') {
    // This SDK's connectionFactory is not wrapped in TLS, and
    // SecureSocket.startConnect has no separate SNI argument. Connect to the
    // checked address, then handshake with the name so the certificate matches.
    final tcp = await Socket.startConnect(addr, port);
    return ConnectionTask.fromSocket(
      tcp.socket.then((plain) => SecureSocket.secure(plain, host: host)),
      tcp.cancel,
    );
  }
  return Socket.startConnect(addr, port);
}

bool _armWalletConnect() {
  walletConnect = walletConnectTask;
  return true;
}

/// Forces the pin to install when this library loads.
final bool walletConnectReady = _armWalletConnect();

/// Empty input keeps the public node. Anything else must be an own-node URL.
String? ownNodeUrlError(String raw) {
  if (raw.trim().isEmpty) return null;
  if (parseOwnNodeUrl(raw) == null) return kOwnNodeUrlError;
  return null;
}

/// A saved own node is not the public node, so the IP confirm is not asked.
/// Remote cleartext http does not parse, so it does not skip the confirm.
bool ownNodeSkipsPublicConsent(String? raw) {
  if (raw == null || raw.trim().isEmpty) return false;
  return parseOwnNodeUrl(raw) != null;
}

/// `host:port` or an http(s) URL. Public Shear hosts are not an own node.
/// Empty input is the public-node default and returns null.
/// A bare public host becomes https. http is kept only for a private host.
String? parseOwnNodeUrl(String raw) {
  var s = raw.trim();
  if (s.isEmpty) return null;
  if (s.contains(' ') || s.contains('@') || s.contains('\\')) return null;
  final hadScheme = s.contains('://');
  if (!hadScheme) s = 'http://$s';
  final u = Uri.tryParse(s);
  if (u == null || !u.hasScheme) return null;
  if (u.scheme != 'http' && u.scheme != 'https') return null;
  if (u.host.isEmpty || u.userInfo.isNotEmpty) return null;
  if (u.query.isNotEmpty || u.fragment.isNotEmpty) return null;
  if (u.path.isNotEmpty && u.path != '/') return null;
  if (u.hasPort && (u.port <= 0 || u.port > 65535)) return null;
  final host = _stripDots(u.host.toLowerCase());
  if (host.isEmpty || host.contains('%')) return null;
  if (hostIsNonCanonicalNumeric(host) || hostIsUnspecified(host)) return null;
  final canon = canonicalHost(host);
  if (canon.isEmpty || isPublicWalletHost(canon) || hostIsUnspecified(canon)) return null;
  final privateHost = ownNodeAllowsHttp(canon);
  var scheme = u.scheme;
  if (!hadScheme && !privateHost) scheme = 'https';
  if (scheme == 'http' && !privateHost) return null;
  final shown = canon.contains(':') ? '[$canon]' : canon;
  final port = u.hasPort ? ':${u.port}' : '';
  return '$scheme://$shown$port';
}

/// http is allowed for loopback, RFC1918, link-local, IPv6 ULA, and `.local`.
bool ownNodeAllowsHttp(String host) {
  final raw = _stripDots(host.toLowerCase());
  if (raw.contains('%')) return false;
  if (raw == 'localhost' || raw.endsWith('.localhost') || raw.endsWith('.local')) return true;
  final h = canonicalHost(raw);
  if (h == 'localhost' || h.endsWith('.localhost') || h.endsWith('.local')) return true;
  final addr = InternetAddress.tryParse(h);
  if (addr == null) return false;
  if (addr.isLoopback) return true;
  final b = addr.rawAddress;
  if (addr.type == InternetAddressType.IPv4) {
    if (b[0] == 10) return true;
    if (b[0] == 127) return true;
    if (b[0] == 192 && b[1] == 168) return true;
    if (b[0] == 172 && b[1] >= 16 && b[1] <= 31) return true;
    if (b[0] == 169 && b[1] == 254) return true;
    return false;
  }
  if ((b[0] & 0xfe) == 0xfc) return true;
  if (b[0] == 0xfe && (b[1] & 0xc0) == 0x80) return true;
  return false;
}

String _stripDots(String host) {
  var h = host;
  while (h.endsWith('.')) {
    h = h.substring(0, h.length - 1);
  }
  return h;
}
