import 'package:flutter/material.dart';

/// Pool light palette.
const shearBg = Color(0xFFEEF3F8);
const shearCard = Color(0xFFFFFFFF);
const shearInk = Color(0xFF0D2137);
const shearMuted = Color(0xFF5A738C);
const shearCyan = Color(0xFF0088A8);
const shearBlue = Color(0xFF1A6FB5);
const shearGreen = Color(0xFF1A9A4A);

ThemeData shearTheme() {
  return ThemeData(
    useMaterial3: true,
    scaffoldBackgroundColor: shearBg,
    colorScheme: const ColorScheme.light(
      surface: shearCard,
      primary: shearCyan,
      secondary: shearBlue,
      onSurface: shearInk,
      onPrimary: Colors.white,
    ),
    appBarTheme: const AppBarTheme(
      backgroundColor: Color(0xFFF7FBFF),
      foregroundColor: shearInk,
      elevation: 0,
    ),
    tabBarTheme: const TabBarThemeData(
      labelColor: shearCyan,
      unselectedLabelColor: shearMuted,
      indicatorColor: shearCyan,
    ),
  );
}
