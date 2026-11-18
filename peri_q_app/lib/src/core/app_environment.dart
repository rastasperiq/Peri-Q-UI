import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'package:flutter/foundation.dart';
import 'package:supabase_flutter/supabase_flutter.dart';

import 'payment_config.dart';

enum AppEnvironmentKind { test, live }

AppEnvironmentKind? parseAppEnvironment(Object? value) => switch (value) {
  'test' => AppEnvironmentKind.test,
  'live' => AppEnvironmentKind.live,
  _ => null,
};

/// The database's own environment marker (`public.app_environment`). Only
/// the database owner can write it, so the app cannot switch environments.
@immutable
class AppEnvironmentMarker {
  const AppEnvironmentMarker({
    required this.environment,
    this.projectRef,
    this.label,
  });

  factory AppEnvironmentMarker.fromRow(Map<String, dynamic> row) =>
      AppEnvironmentMarker(
        environment: parseAppEnvironment(row['environment']),
        projectRef: row['project_ref'] as String?,
        label: row['label'] as String?,
      );

  final AppEnvironmentKind? environment;
  final String? projectRef;
  final String? label;
}

/// Non-secret environment details for the admin dashboard, from the
/// website's admin-only `/api/environment/` endpoint.
@immutable
class EnvironmentStatus {
  const EnvironmentStatus({
    required this.environment,
    required this.databaseProvider,
    required this.databaseProjectRef,
    required this.databaseMarker,
    required this.databaseStatus,
    required this.lastDatabaseCheckAt,
    required this.applicationUrl,
    required this.paymentGatewayMode,
    required this.authEnvironment,
    required this.ok,
    required this.issues,
  });

  factory EnvironmentStatus.fromJson(Map<String, dynamic> json) {
    final issues = (json['issues'] as List<dynamic>? ?? const [])
        .whereType<Map<String, dynamic>>()
        .map(
          (issue) =>
              '${issue['level'] == 'block' ? 'Blocked' : 'Note'}: ${issue['message']}',
        )
        .toList(growable: false);
    return EnvironmentStatus(
      environment: parseAppEnvironment(json['environment']),
      databaseProvider: json['databaseProvider'] as String? ?? 'Supabase',
      databaseProjectRef: json['databaseProjectRef'] as String?,
      databaseMarker: parseAppEnvironment(json['databaseMarker']),
      databaseStatus: json['databaseStatus'] as String? ?? 'unknown',
      lastDatabaseCheckAt: DateTime.tryParse(
        json['lastDatabaseCheckAt'] as String? ?? '',
      ),
      applicationUrl: json['applicationUrl'] as String?,
      paymentGatewayMode: json['paymentGatewayMode'] as String?,
      authEnvironment: json['authEnvironment'] as String?,
      ok: json['ok'] == true,
      issues: issues,
    );
  }

  final AppEnvironmentKind? environment;
  final String databaseProvider;
  final String? databaseProjectRef;
  final AppEnvironmentKind? databaseMarker;
  final String databaseStatus;
  final DateTime? lastDatabaseCheckAt;
  final String? applicationUrl;
  final String? paymentGatewayMode;
  final String? authEnvironment;
  final bool ok;
  final List<String> issues;
}

/// Which environment the app is talking to.
class AppEnvironmentService {
  AppEnvironmentService({String buildEnvironment = _buildEnvironment})
    : _buildHint = parseAppEnvironment(buildEnvironment.trim().toLowerCase());

  static final AppEnvironmentService instance = AppEnvironmentService();

  /// Optional build hint. It can only add the TEST banner, never remove it:
  /// the database marker is the authority.
  static const String _buildEnvironment = String.fromEnvironment(
    'APP_ENVIRONMENT',
  );

  final AppEnvironmentKind? _buildHint;

  final ValueNotifier<AppEnvironmentMarker?> marker = ValueNotifier(null);

  /// Show TEST indicators when either the database or the build says TEST.
  bool get isTest =>
      marker.value?.environment == AppEnvironmentKind.test ||
      _buildHint == AppEnvironmentKind.test;

  bool get isLive =>
      !isTest && marker.value?.environment == AppEnvironmentKind.live;

  Future<void> loadMarker(SupabaseClient client) async {
    try {
      final row = await client
          .from('app_environment')
          .select('environment,project_ref,label')
          .maybeSingle();
      marker.value = row == null ? null : AppEnvironmentMarker.fromRow(row);
    } catch (_) {
      // An older database without the marker table: no indicator.
    }
  }

  Future<EnvironmentStatus> fetchAdminStatus(SupabaseClient client) async {
    final endpoint = environmentStatusUri();
    final token = client.auth.currentSession?.accessToken;
    if (endpoint == null || token == null || token.isEmpty) {
      throw const EnvironmentStatusException(
        'Sign in as an administrator to see environment details.',
      );
    }
    final http = HttpClient()..connectionTimeout = const Duration(seconds: 15);
    try {
      final request = await http.getUrl(endpoint);
      request.headers.set('Authorization', 'Bearer $token');
      final response = await request.close().timeout(
        const Duration(seconds: 20),
      );
      final text = await utf8.decoder.bind(response).join();
      final body = jsonDecode(text);
      if (response.statusCode != 200 || body is! Map<String, dynamic>) {
        throw EnvironmentStatusException(
          body is Map<String, dynamic> && body['error'] is String
              ? body['error'] as String
              : 'Environment details are unavailable right now.',
        );
      }
      return EnvironmentStatus.fromJson(body);
    } on EnvironmentStatusException {
      rethrow;
    } on Object {
      throw const EnvironmentStatusException(
        'Environment details are unavailable right now.',
      );
    } finally {
      http.close(force: true);
    }
  }
}

class EnvironmentStatusException implements Exception {
  const EnvironmentStatusException(this.message);

  final String message;

  @override
  String toString() => message;
}
