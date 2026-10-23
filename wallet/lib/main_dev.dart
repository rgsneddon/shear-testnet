import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';

import 'shear_book_dev.dart';

/// Dev wallet entry. Refuses release and profile builds. No dart-define.
void main() {
  if (kReleaseMode || kProfileMode) {
    throw StateError('shear-dev wallet refuses release mode');
  }
  runApp(const ShearDevApp());
}

class ShearDevApp extends StatelessWidget {
  const ShearDevApp({super.key});

  @override
  Widget build(BuildContext context) {
    return MaterialApp(
      title: 'shear-dev',
      home: Scaffold(
        body: Center(
          child: Text('This wallet is for $kBookMagic'),
        ),
      ),
    );
  }
}
