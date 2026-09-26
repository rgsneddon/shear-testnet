import 'package:flutter/material.dart';

/// Installed by pasting its vort1. Not in the lean Continuum roster.
const kRestorePrivacyProgram = 'restore-privacy-v1';
const kRestorePrivacyName = 'Restore Privacy';

/// Device tunnel the Closure tick box starts.
///
/// The connection itself is IPv4 and IPv6. Every extended control starts off.
/// The Restore Privacy vortice is where those controls can be turned on.
class ShearVpnProfile {
  bool ipv4 = true;
  bool ipv6 = true;
  bool trafficShape = false;
  bool outerObfuscation = false;

  bool get extendedOn => trafficShape || outerObfuscation;

  Map<String, bool> get connectArgs => {
        'ipv4': ipv4,
        'ipv6': ipv6,
        'trafficShape': trafficShape,
        'outerObfuscation': outerObfuscation,
      };
}

/// Client UI for the Restore Privacy vort1. Extended switches start off.
class RestorePrivacyPane extends StatelessWidget {
  const RestorePrivacyPane({
    super.key,
    required this.profile,
    required this.onChanged,
  });

  final ShearVpnProfile profile;
  final VoidCallback onChanged;

  @override
  Widget build(BuildContext context) {
    return Column(
      key: const Key('restore-privacy-pane'),
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        const Text(kRestorePrivacyName, style: TextStyle(fontWeight: FontWeight.w700)),
        const SizedBox(height: 8),
        const Text(
          'Default connection is IPv4 and IPv6. Extended controls start off. '
          'The Closure tick box joins this tunnel after the device approves it.',
        ),
        const SizedBox(height: 8),
        Text(profile.ipv4 ? 'IPv4 on' : 'IPv4 off', key: const Key('restore-privacy-ipv4')),
        Text(profile.ipv6 ? 'IPv6 on' : 'IPv6 off', key: const Key('restore-privacy-ipv6')),
        SwitchListTile(
          key: const Key('restore-privacy-traffic-shape'),
          contentPadding: EdgeInsets.zero,
          title: const Text('Traffic shape'),
          subtitle: const Text('Pad, cover, and jitter. Off until you turn this on.'),
          value: profile.trafficShape,
          onChanged: (on) {
            profile.trafficShape = on;
            onChanged();
          },
        ),
        SwitchListTile(
          key: const Key('restore-privacy-obfuscation'),
          contentPadding: EdgeInsets.zero,
          title: const Text('Outer obfuscation'),
          subtitle: const Text('Off until you turn this on.'),
          value: profile.outerObfuscation,
          onChanged: (on) {
            profile.outerObfuscation = on;
            onChanged();
          },
        ),
      ],
    );
  }
}
