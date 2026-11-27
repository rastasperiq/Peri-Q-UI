import 'package:flutter/services.dart' show appFlavor;

abstract final class AuthDeepLinks {
  static final String scheme = schemeFor(appFlavor);
  static const String resetPasswordHost = 'reset-password';
  static final String resetPasswordUrl = '$scheme://$resetPasswordHost';

  /// The TEST app installs beside the live one, so its password links need
  /// their own scheme. Matches `authScheme` in android/app/build.gradle.kts.
  static String schemeFor(String? flavor) =>
      flavor == 'staging' ? 'rastasperiq-test' : 'rastasperiq';

  static bool isPasswordReset(Uri uri) {
    return uri.scheme == scheme && uri.host == resetPasswordHost;
  }
}
