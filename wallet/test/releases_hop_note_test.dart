import 'dart:io';

import 'package:flutter_test/flutter_test.dart';

void main() {
  test('release notes say the relay shipped and that it was removed', () {
    final notes = File('RELEASES.md').readAsStringSync();
    expect(notes, contains('privacy hop removed'));
    for (final pin in ['0.43', '0.44', '0.45', '0.46']) {
      final start = notes.indexOf('## $pin');
      expect(start, greaterThanOrEqualTo(0), reason: pin);
      final next = notes.indexOf('\n## ', start + 4);
      final section = notes.substring(start, next < 0 ? notes.length : next);
      expect(section.toLowerCase(), contains('hop'), reason: pin);
      expect(section.contains('<hop-host>'), isFalse, reason: pin);
      expect(section.contains('44044'), isFalse, reason: pin);
    }
  });
}
