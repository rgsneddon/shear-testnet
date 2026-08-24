import 'package:flutter/material.dart';

/// Pack-derived in-app art.
const kShearLogoAsset = 'assets/brand/logo.png';
const kShearWordmarkLight = 'assets/brand/wordmark-light.png';
const kShearWordmarkDark = 'assets/brand/wordmark-dark.png';

/// Pool light palette.
const shearBg = Color(0xFFEEF3F8);
const shearCard = Color(0xFFFFFFFF);
const shearInk = Color(0xFF0D2137);
const shearMuted = Color(0xFF5A738C);
const shearCyan = Color(0xFF0088A8);
const shearBlue = Color(0xFF1A6FB5);
const shearGreen = Color(0xFF1A9A4A);

/// Dark palette (pack dark-bg / wordmark-dark).
const shearDarkBg = Color(0xFF0A1628);
const shearDarkCard = Color(0xFF132A4A);
const shearDarkInk = Color(0xFFE8F1F8);
const shearDarkMuted = Color(0xFF8AA4BC);
const shearDarkCyan = Color(0xFF4FD8E8);

ThemeData shearTheme() => shearLightTheme();

ThemeData shearLightTheme() {
  return ThemeData(
    useMaterial3: true,
    brightness: Brightness.light,
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
    cardColor: shearCard,
    tabBarTheme: const TabBarThemeData(
      labelColor: shearCyan,
      unselectedLabelColor: shearMuted,
      indicatorColor: shearCyan,
    ),
  );
}

ThemeData shearDarkTheme() {
  return ThemeData(
    useMaterial3: true,
    brightness: Brightness.dark,
    scaffoldBackgroundColor: shearDarkBg,
    colorScheme: const ColorScheme.dark(
      surface: shearDarkCard,
      primary: shearDarkCyan,
      secondary: shearBlue,
      onSurface: shearDarkInk,
      onPrimary: shearDarkBg,
    ),
    appBarTheme: const AppBarTheme(
      backgroundColor: Color(0xFF06141F),
      foregroundColor: shearDarkInk,
      elevation: 0,
    ),
    cardColor: shearDarkCard,
    tabBarTheme: const TabBarThemeData(
      labelColor: shearDarkCyan,
      unselectedLabelColor: shearDarkMuted,
      indicatorColor: shearDarkCyan,
    ),
  );
}

String shearWordmarkAsset(Brightness b) =>
    b == Brightness.dark ? kShearWordmarkDark : kShearWordmarkLight;
