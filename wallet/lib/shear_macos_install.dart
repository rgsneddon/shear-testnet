import 'dart:io';

const macosMoveTitle = 'Install Shear';
const macosMoveBody =
    'Move the Shear app (the extracted executable) into Applications. '
    'Do not keep running it from the disk image, a zip, or Downloads.';
const macosMoveRequiredBody =
    'This copy is running from a temporary disk. '
    'Move Shear into Applications, then relaunch.';

String? macosAppBundlePath(String resolvedExecutable) {
  final path = resolvedExecutable.replaceAll('\\', '/').toLowerCase();
  final idx = path.indexOf('.app/contents/macos/');
  if (idx < 0) return null;
  return resolvedExecutable.substring(0, idx + 4);
}

bool isInstalledInApplications(String resolvedExecutable) {
  final bundle = macosAppBundlePath(resolvedExecutable);
  if (bundle == null) return false;
  return bundle.contains('/Applications/');
}

bool isEphemeralMacosLaunchPath(String resolvedExecutable) {
  final bundle = macosAppBundlePath(resolvedExecutable);
  if (bundle == null) return false;
  if (isInstalledInApplications(bundle)) return false;
  final lower = bundle.toLowerCase();
  return lower.contains('/volumes/') ||
      lower.contains('/var/folders/') ||
      lower.contains('/downloads/');
}
