/// Win32 fusion `windowsSettings` that CreateActCtx will accept.
///
/// Microsoft SMI schemas for unpackaged Win32 do not include UWP/MSIX
/// capabilities such as `webcam`. An unregistered setting fails SxS
/// activation with Win32 14001 (`ERROR_SXS_CANT_GEN_ACTCTX`) before
/// `wWinMain`. PR #24's `<webcam xmlns="http://schemas.microsoft.com/SMI/2019/WindowsSettings">`
/// is the named break: SMI/2019 only registers `activeCodePage`.
const kLegalFusionWindowsSettings = {
  'dpiAwareness',
  'dpiAware',
  'activeCodePage',
  'longPathAware',
  'gdiScaling',
  'heapType',
  'disableTheming',
  'disableWindowFiltering',
  'printerDriverIsolation',
};

const kWin10Win11SupportedOsId = '{8e0f7a12-bfb3-4fe8-b9a5-48fd50a15a9a}';

String stripXmlComments(String xml) =>
    xml.replaceAll(RegExp(r'<!--.*?-->', dotAll: true), '');

/// Local names of element children of `<windowsSettings>`.
List<String> fusionWindowsSettingNames(String xml) {
  final stripped = stripXmlComments(xml);
  final match = RegExp(
    r'<windowsSettings\b[^>]*>(.*?)</windowsSettings>',
    dotAll: true,
  ).firstMatch(stripped);
  if (match == null) return const [];
  return RegExp(r'<([A-Za-z_][\w:.-]*)\b')
      .allMatches(match.group(1)!)
      .map((m) {
        final raw = m.group(1)!;
        return raw.contains(':') ? raw.split(':').last : raw;
      })
      .toList();
}

/// Throws a [StateError] if [xml] is not a schema-legal Win32 fusion manifest.
void checkFusionManifestLegal(String xml) {
  final stripped = stripXmlComments(xml).trim();
  if (!stripped.contains('urn:schemas-microsoft-com:asm.v1')) {
    throw StateError('fusion XML missing asm.v1 assembly namespace');
  }
  if (!RegExp(r'<assembly\b').hasMatch(stripped)) {
    throw StateError('fusion XML missing <assembly>');
  }
  if (!stripped.contains(kWin10Win11SupportedOsId)) {
    throw StateError('fusion XML missing Win10/11 supportedOS');
  }
  final names = fusionWindowsSettingNames(stripped);
  if (!names.contains('dpiAwareness')) {
    throw StateError('fusion XML missing dpiAwareness windowsSettings');
  }
  if (!stripped.contains('PerMonitorV2')) {
    throw StateError('fusion XML dpiAwareness is not PerMonitorV2');
  }
  for (final name in names) {
    if (name == 'webcam') {
      throw StateError(
        'illegal SxS windowsSettings <webcam>: SMI/2019 does not register it; '
        'CreateActCtx fails with ERROR_SXS_CANT_GEN_ACTCTX (14001)',
      );
    }
    if (!kLegalFusionWindowsSettings.contains(name)) {
      throw StateError('illegal SxS windowsSettings <$name>');
    }
  }
}

/// PR #24 runner.exe.manifest fragment that broke Continuum 0.41 on Windows.
const kPr24IllegalWebcamFusionXml = '''
<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<assembly xmlns="urn:schemas-microsoft-com:asm.v1" manifestVersion="1.0">
  <application xmlns="urn:schemas-microsoft-com:asm.v3">
    <windowsSettings>
      <dpiAwareness xmlns="http://schemas.microsoft.com/SMI/2016/WindowsSettings">PerMonitorV2</dpiAwareness>
      <webcam xmlns="http://schemas.microsoft.com/SMI/2019/WindowsSettings">true</webcam>
    </windowsSettings>
  </application>
  <compatibility xmlns="urn:schemas-microsoft-com:compatibility.v1">
    <application>
      <supportedOS Id="{8e0f7a12-bfb3-4fe8-b9a5-48fd50a15a9a}"/>
    </application>
  </compatibility>
</assembly>
''';
