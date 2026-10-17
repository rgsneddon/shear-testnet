/// Consent before a public-node post. There is no Tor path.
///
/// A public-node post is refused until the user accepts [kUnprivateConfirmLabel].
/// An own node on https, or on http to this machine or the LAN, does not ask.
import 'dart:io';

import 'shear_read_sync.dart';

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

/// Parse, then refuse a host that resolves to a public Shear address.
/// http is kept only when every resolved address is loopback or RFC1918.
Future<String?> acceptOwnNodeUrl(String raw) async {
  final parsed = parseOwnNodeUrl(raw);
  if (parsed == null) return null;
  final uri = Uri.parse(parsed);
  List<InternetAddress> addrs;
  try {
    addrs = await ownNodeLookup(uri.host);
  } catch (_) {
    return null;
  }
  if (addrs.isEmpty) return null;
  for (final addr in addrs) {
    final canon = ipv4OfAddress(addr) ?? addr.address;
    if (hostIsUnspecified(canon) || isPublicWalletHost(canon)) return null;
    if (uri.scheme == 'http' && !ownNodeAllowsHttp(canon) && !addr.isLoopback) return null;
  }
  return parsed;
}

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
