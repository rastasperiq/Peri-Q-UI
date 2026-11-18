import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:peri_q_app/src/core/app_environment.dart';
import 'package:peri_q_app/src/core/payment_config.dart';
import 'package:peri_q_app/src/widgets/environment_indicators.dart';

AppEnvironmentService _service(
  AppEnvironmentKind? marker, {
  String build = '',
}) {
  final service = AppEnvironmentService(buildEnvironment: build);
  service.marker.value = marker == null
      ? null
      : AppEnvironmentMarker(environment: marker, projectRef: 'x', label: 'L');
  return service;
}

Widget _host(AppEnvironmentService service) => MaterialApp(
  home: TestModeBanner(
    service: service,
    child: Scaffold(
      appBar: AppBar(
        title: Row(
          children: [
            const Text('Screen'),
            TestModeTag(service: service),
            EnvironmentBadge(service: service),
          ],
        ),
      ),
    ),
  ),
);

void main() {
  test('parses the database marker', () {
    final marker = AppEnvironmentMarker.fromRow({
      'environment': 'test',
      'project_ref': 'abcdefghijklmnopqrst',
      'label': 'TEST',
    });
    expect(marker.environment, AppEnvironmentKind.test);
    expect(
      AppEnvironmentMarker.fromRow({'environment': 'staging'}).environment,
      isNull,
    );
  });

  test('the build hint can add TEST but never hide it', () {
    expect(_service(null, build: 'test').isTest, isTrue);
    expect(_service(AppEnvironmentKind.test, build: 'live').isTest, isTrue);
    expect(_service(AppEnvironmentKind.live, build: 'test').isLive, isFalse);
    expect(_service(AppEnvironmentKind.live).isLive, isTrue);
    expect(_service(null).isTest, isFalse);
  });

  testWidgets('TEST shows the orange banner, tag and TEST badge', (
    tester,
  ) async {
    await tester.pumpWidget(_host(_service(AppEnvironmentKind.test)));
    expect(find.byKey(const ValueKey('test-mode-banner')), findsOneWidget);
    expect(find.textContaining('TEST MODE ·'), findsOneWidget);
    expect(find.byKey(const ValueKey('test-mode-tag')), findsOneWidget);
    expect(
      find.byKey(const ValueKey('environment-badge-test')),
      findsOneWidget,
    );
  });

  testWidgets('LIVE shows only the LIVE badge', (tester) async {
    await tester.pumpWidget(_host(_service(AppEnvironmentKind.live)));
    expect(find.byKey(const ValueKey('test-mode-banner')), findsNothing);
    expect(find.byKey(const ValueKey('test-mode-tag')), findsNothing);
    expect(
      find.byKey(const ValueKey('environment-badge-live')),
      findsOneWidget,
    );
    expect(find.textContaining('TEST'), findsNothing);
  });

  testWidgets('the banner appears when the marker loads later', (tester) async {
    final service = _service(null);
    await tester.pumpWidget(_host(service));
    expect(find.byKey(const ValueKey('test-mode-banner')), findsNothing);
    service.marker.value = const AppEnvironmentMarker(
      environment: AppEnvironmentKind.test,
    );
    await tester.pump();
    expect(find.byKey(const ValueKey('test-mode-banner')), findsOneWidget);
  });

  testWidgets('the admin panel shows non-secret details', (tester) async {
    final status = EnvironmentStatus.fromJson({
      'environment': 'test',
      'databaseProvider': 'Supabase',
      'databaseProjectRef': 'abcdefghijklmnopqrst',
      'databaseMarker': 'test',
      'databaseStatus': 'connected',
      'lastDatabaseCheckAt': '2026-11-18T10:00:00.000Z',
      'applicationUrl': 'https://staging.rastasperiq.co.za',
      'paymentGatewayMode': 'test',
      'authEnvironment': 'Supabase Auth (abcdefghijklmnopqrst)',
      'ok': true,
      'issues': <Object>[],
    });
    await tester.pumpWidget(
      MaterialApp(
        home: Scaffold(
          body: SingleChildScrollView(
            child: EnvironmentStatusCard(load: () async => status),
          ),
        ),
      ),
    );
    await tester.pump();
    expect(
      find.text('All records in this environment are test records.'),
      findsOneWidget,
    );
    expect(find.text('abcdefghijklmnopqrst'), findsOneWidget);
    expect(find.text('Yoco TEST'), findsOneWidget);
    expect(find.text('https://staging.rastasperiq.co.za'), findsOneWidget);
  });

  testWidgets('the admin panel explains when details are unavailable', (
    tester,
  ) async {
    await tester.pumpWidget(
      MaterialApp(
        home: Scaffold(
          body: EnvironmentStatusCard(
            load: () async => throw const EnvironmentStatusException('Nope.'),
          ),
        ),
      ),
    );
    await tester.pump();
    expect(find.text('Nope.'), findsOneWidget);
  });

  test('the environment endpoint is https only', () {
    expect(
      environmentStatusUri().toString(),
      'https://rastasperiq.co.za/api/environment/',
    );
    expect(environmentStatusUri(override: 'http://x.test/'), isNull);
  });
}
