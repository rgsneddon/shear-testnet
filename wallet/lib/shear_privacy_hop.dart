import 'package:flutter/foundation.dart';
import 'package:flutter/services.dart';

import 'shear_identity.dart';
import 'shear_levy.dart';
import 'shear_read_sync.dart';
import 'shear_vpn_profile.dart';

/// Residual hop daemon for Continuum Reserve (restore-privacy RPT2).
const kPrivacyHopHost = '77.42.91.84';
const kPrivacyHopPort = 44044;
const kPrivacyHopLabel = 'SHEAR-HOP / EU';
const kPrivacyHopChannel = 'shear/privacy_hop';
const kPrivacyHopSessionName = 'SHEAR-HOP / EU';
const kPrivacyHopButtonLabel = 'Privacy hop';

/// Android VpnService handshake budget. Kotlin `HOP_HANDSHAKE_TIMEOUT_MS` matches.
const kPrivacyHopHandshakeTimeoutMs = 15000;

/// HELLO attempts. Kotlin `HOP_HANDSHAKE_ATTEMPTS` matches. Never above 3.
const kPrivacyHopHandshakeAttempts = 3;

/// Session poll after the service starts. Above the handshake budget so TUN
/// setup can finish, and well under the old 70s wait.
const kPrivacyHopSessionWaitMs = 20000;

const kHopProgressPaying = 'Paying hop fee…';
const kHopProgressConnecting = 'Connecting Privacy hop…';

/// Fixed hop click fee. Lands on [kPoolFeeDest] (ssa1), never she1.
/// One number for every platform that runs this wallet.
const kPrivacyHopFeeShe = 0.0;
const kPrivacyHopFeeDest = kPoolFeeDest;

String get kPrivacyHopFeeSheText => '$kPrivacyHopFeeShe SHE';

String get kPrivacyHopFeeConfirmTitle => 'Pay $kPrivacyHopFeeSheText for Privacy hop';

String get kPrivacyHopFeeConfirmBody =>
    'Send $kPrivacyHopFeeSheText to the pool fee dest, then connect SHEAR-HOP / EU. '
    'The hop fee uses the public node. Reserve Send then goes through the hop.';

String get kPrivacyHopFeePayLabel => 'Pay $kPrivacyHopFeeSheText';

const kUnprivateSendLabel = 'Send without privacy hop';
const kUnprivateConfirmTitle = 'Send without Shear privacy hop';
const kUnprivateConfirmLabel = 'I already use a VPN / I accept exposing my IP';
const kUnprivateConfirmHelper =
    'Skip Shear privacy hop. If you are not already on a VPN, the public node may see your device IP.';

/// Standing Reserve warning. A send to the vault uses the public node.
const kReserveIpDisclaimer =
    'Sending to the Reserve shows your IP to the node. Use a VPN.';

const kReserveHopWaitCopy =
    'Confirm you use a VPN, or accept the node seeing your IP, before Send.';

const kUnprivateUnlockedBanner =
    'Unprivate send unlocked — public node may see your IP unless you already use a VPN';

String reservePublicWaitCopy({required bool unprivateConfirmed}) =>
    unprivateConfirmed ? kUnprivateUnlockedBanner : kReserveHopWaitCopy;

enum PrivacyHopState { off, connecting, up, error }

String privacyHopStateLabel(PrivacyHopState s) {
  switch (s) {
    case PrivacyHopState.off:
      return 'Privacy hop off';
    case PrivacyHopState.connecting:
      return 'Privacy hop connecting…';
    case PrivacyHopState.up:
      return 'Privacy hop up · $kPrivacyHopLabel';
    case PrivacyHopState.error:
      return 'Privacy hop error';
  }
}

bool reserveSendReady({
  required bool hopUp,
  String? poolUrl,
  bool skipPoolSync = false,
  bool enforceHopGate = false,
  bool unprivateConfirmed = false,
}) {
  if (skipPoolSync && !enforceHopGate) return true;
  if (localSendReady(poolUrl)) return true;
  if (hopUp) return true;
  if (unprivateConfirmed) return true;
  return false;
}

/// Any finite positive SHE amount. No magnitude ceiling.
bool unprivateAmountPermitted(double she) => she.isFinite && she > 0;

bool reserveVaultSendReady({
  required bool skipPoolSync,
  bool enforceHopGate = false,
  String? poolUrl,
  PrivacyHopState hop = PrivacyHopState.off,
  bool unprivateConfirmed = false,
}) =>
    reserveSendReady(
      hopUp: hop == PrivacyHopState.up,
      poolUrl: poolUrl,
      skipPoolSync: skipPoolSync,
      enforceHopGate: enforceHopGate,
      unprivateConfirmed: unprivateConfirmed,
    );

bool privacyHopFeeDestOk(String dest) {
  final t = dest.trim();
  if (t.startsWith('she1') || t.startsWith('shear1')) return false;
  if (t.contains('she1')) return false;
  if (!isDestAddress(t)) return false;
  return t == kPrivacyHopFeeDest || t == poolFeeDest();
}

bool hopFeeDestIsSsa1(String dest) => privacyHopFeeDestOk(dest);

const kErrPrivacyVpn = 'Couldn’t reach Shear Privacy VPN — try again';

/// Probe-up is not a TUN. Desktop must not claim the IP is masked.
bool privacyHopClaimsIpMask({
  required bool tunUp,
  required bool probeOnly,
}) =>
    tunUp && !probeOnly;

class PublicSendGate {
  const PublicSendGate({required this.sendBlocked, required this.claimsIpMask, this.error});
  final bool sendBlocked;
  final bool claimsIpMask;
  final String? error;
}

PublicSendGate publicSendGate({
  required bool vpnMode,
  required bool tunUp,
  required bool probeOnly,
  required bool localReady,
}) {
  if (!vpnMode) {
    return PublicSendGate(sendBlocked: !localReady, claimsIpMask: false, error: localReady ? null : kErrPrivacyVpn);
  }
  final mask = privacyHopClaimsIpMask(tunUp: tunUp, probeOnly: probeOnly);
  if (!mask) {
    return const PublicSendGate(sendBlocked: true, claimsIpMask: false, error: kErrPrivacyVpn);
  }
  return const PublicSendGate(sendBlocked: false, claimsIpMask: true);
}

class PrivacyHopController extends ChangeNotifier {
  PrivacyHopController({
    this.mock = false,
    this.connectImpl,
    MethodChannel? channel,
    PrivacyHopState initial = PrivacyHopState.off,
  })  : _channel = channel ?? const MethodChannel(kPrivacyHopChannel),
        state = initial;

  final bool mock;
  final Future<bool> Function()? connectImpl;
  final MethodChannel _channel;

  PrivacyHopState state;
  String message = '';
  String? vpnIp;

  /// Real VpnService / TUN. A UDP HELLO does not set this.
  bool tunVerified = false;

  /// Reachable sibling without a verified TUN. Must not open a public send.
  bool probeOnly = false;

  /// Resistance CLI lines for the device tunnel. Capped.
  final List<String> log = [];

  bool get isUp => state == PrivacyHopState.up && tunVerified && !probeOnly;

  void _log(String line) {
    if (line.isEmpty) return;
    log.add(line);
    if (log.length > 80) log.removeAt(0);
  }

  /// Desktop UDP HELLO. Leaves the public send blocked.
  void noteProbeOnly() {
    tunVerified = false;
    probeOnly = true;
    state = PrivacyHopState.error;
    message = kErrPrivacyVpn;
    _log(message);
    notifyListeners();
  }

  /// Test and Android TUN stand-in. Probe-only must not call this.
  void noteTunUp({String? vpnAddress}) {
    tunVerified = true;
    probeOnly = false;
    state = PrivacyHopState.up;
    final ip = vpnAddress?.trim();
    if (ip != null && ip.isNotEmpty) vpnIp = ip;
    message = '$kPrivacyHopLabel up';
    _log(vpnIp != null && vpnIp!.isNotEmpty ? 'device tunnel up $vpnIp' : 'device tunnel up');
    notifyListeners();
  }

  /// A privacy-hop send while the device tunnel is up.
  void noteDeviceSend() {
    final ip = vpnIp;
    _log(ip != null && ip.isNotEmpty ? 'send via device tunnel $ip' : 'send via device tunnel');
    notifyListeners();
  }
  bool get isConnecting => state == PrivacyHopState.connecting;

  String statusLine() => message.isNotEmpty ? message : privacyHopStateLabel(state);

  Future<bool> connect({
    String host = kPrivacyHopHost,
    int port = kPrivacyHopPort,
    ShearVpnProfile? profile,
  }) async {
    if (isUp) return true;
    final use = profile ?? ShearVpnProfile();
    state = PrivacyHopState.connecting;
    message = 'Waiting for device VPN approval…';
    _log('Waiting for device VPN approval');
    _log(use.extendedOn ? 'extended controls on' : 'extended controls off');
    _log('${use.ipv4 ? 'ipv4' : ''} ${use.ipv6 ? 'ipv6' : ''}'.trim());
    notifyListeners();
    final impl = connectImpl;
    if (impl != null) {
      final ok = await impl();
      tunVerified = ok;
      probeOnly = !ok;
      state = ok ? PrivacyHopState.up : PrivacyHopState.error;
      message = ok ? '$kPrivacyHopLabel up' : kErrPrivacyVpn;
      _log(ok ? 'device tunnel up' : message);
      notifyListeners();
      return ok;
    }
    if (mock) {
      noteTunUp();
      return true;
    }
    try {
      final raw = await _channel.invokeMethod<dynamic>('connect', {
        'host': host,
        'port': port,
        'fullTunnel': true,
        'sessionName': kPrivacyHopSessionName,
        'label': kPrivacyHopLabel,
        'timeoutMs': kPrivacyHopHandshakeTimeoutMs,
        'attempts': kPrivacyHopHandshakeAttempts,
        ...use.connectArgs,
      });
      final map = raw is Map<String, dynamic>
          ? raw
          : raw is Map
              ? Map<String, dynamic>.from(raw)
              : <String, dynamic>{};
      final declared = map.containsKey('deviceApproval');
      final approved = !declared || map['deviceApproval'] == true;
      final tun = map['fullTunnelActive'] == true && approved;
      tunVerified = tun;
      probeOnly = !tun;
      if (tun) {
        state = PrivacyHopState.up;
        final ip = map['vpnIp']?.toString().trim();
        if (ip != null && ip.isNotEmpty) vpnIp = ip;
        message = (map['message'] as String?)?.trim().isNotEmpty == true
            ? map['message'] as String
            : '$kPrivacyHopLabel up';
        _log(vpnIp != null && vpnIp!.isNotEmpty ? 'device tunnel up $vpnIp' : 'device tunnel up');
        notifyListeners();
        return true;
      }
      state = PrivacyHopState.error;
      message = (map['message'] as String?)?.trim().isNotEmpty == true
          ? map['message'] as String
          : kErrPrivacyVpn;
      _log(message);
      notifyListeners();
      return false;
    } on MissingPluginException {
      tunVerified = false;
      probeOnly = true;
      state = PrivacyHopState.error;
      message =
          'Privacy hop native channel missing on this build. Android uses VpnService.';
      notifyListeners();
      return false;
    } on PlatformException catch (e) {
      tunVerified = false;
      probeOnly = true;
      state = PrivacyHopState.error;
      message = e.message ?? e.code;
      notifyListeners();
      return false;
    }
  }

  Future<void> disconnect() async {
    if (!mock && connectImpl == null) {
      try {
        await _channel.invokeMethod<dynamic>('disconnect');
      } catch (_) {}
    }
    state = PrivacyHopState.off;
    tunVerified = false;
    probeOnly = false;
    message = 'Privacy hop off';
    vpnIp = null;
    _log('VPN tunnel off');
    notifyListeners();
  }

  void mockUp() {
    noteTunUp();
  }
}

typedef PrivacyHop = PrivacyHopController;
