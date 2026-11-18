import 'package:flutter/material.dart';

import '../core/app_environment.dart';

const Color testModeOrange = Color(0xFFFF7A00);
const Color _onTestModeOrange = Color(0xFF141110);

/// Orange TEST MODE strip above every screen when the app is connected to the
/// TEST database. Shows nothing on LIVE.
class TestModeBanner extends StatelessWidget {
  const TestModeBanner({super.key, required this.child, this.service});

  final Widget child;
  final AppEnvironmentService? service;

  @override
  Widget build(BuildContext context) {
    final env = service ?? AppEnvironmentService.instance;
    return ValueListenableBuilder<AppEnvironmentMarker?>(
      valueListenable: env.marker,
      builder: (context, _, _) {
        if (!env.isTest) return child;
        final padding = MediaQuery.paddingOf(context);
        return Column(
          children: [
            Material(
              key: const ValueKey('test-mode-banner'),
              color: testModeOrange,
              child: Padding(
                padding: EdgeInsets.fromLTRB(12, padding.top + 6, 12, 6),
                child: Semantics(
                  liveRegion: true,
                  child: const Text(
                    'TEST MODE · All accounts, orders and payments are test records. No real money is charged.',
                    textAlign: TextAlign.center,
                    style: TextStyle(
                      color: _onTestModeOrange,
                      fontSize: 12,
                      fontWeight: FontWeight.w700,
                    ),
                  ),
                ),
              ),
            ),
            Expanded(
              child: MediaQuery.removePadding(
                context: context,
                removeTop: true,
                child: child,
              ),
            ),
          ],
        );
      },
    );
  }
}

/// Small TEST chip for payment and order screens. Nothing on LIVE.
class TestModeTag extends StatelessWidget {
  const TestModeTag({super.key, this.service});

  final AppEnvironmentService? service;

  @override
  Widget build(BuildContext context) {
    final env = service ?? AppEnvironmentService.instance;
    return ValueListenableBuilder<AppEnvironmentMarker?>(
      valueListenable: env.marker,
      builder: (context, _, _) {
        if (!env.isTest) return const SizedBox.shrink();
        return const _Badge(
          key: ValueKey('test-mode-tag'),
          text: 'TEST MODE',
          background: testModeOrange,
          foreground: _onTestModeOrange,
        );
      },
    );
  }
}

/// LIVE / TEST badge for the admin dashboard.
class EnvironmentBadge extends StatelessWidget {
  const EnvironmentBadge({super.key, this.service});

  final AppEnvironmentService? service;

  @override
  Widget build(BuildContext context) {
    final env = service ?? AppEnvironmentService.instance;
    return ValueListenableBuilder<AppEnvironmentMarker?>(
      valueListenable: env.marker,
      builder: (context, _, _) {
        if (env.isTest) {
          return const _Badge(
            key: ValueKey('environment-badge-test'),
            text: 'TEST',
            background: testModeOrange,
            foreground: _onTestModeOrange,
          );
        }
        if (env.isLive) {
          return const _Badge(
            key: ValueKey('environment-badge-live'),
            text: 'LIVE · PRODUCTION',
            background: Color(0xFF1B7F3B),
            foreground: Colors.white,
          );
        }
        return const SizedBox.shrink();
      },
    );
  }
}

class _Badge extends StatelessWidget {
  const _Badge({
    super.key,
    required this.text,
    required this.background,
    required this.foreground,
  });

  final String text;
  final Color background;
  final Color foreground;

  @override
  Widget build(BuildContext context) {
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 4),
      decoration: BoxDecoration(
        color: background,
        borderRadius: BorderRadius.circular(999),
      ),
      child: Text(
        text,
        style: TextStyle(
          color: foreground,
          fontSize: 12,
          fontWeight: FontWeight.w800,
          letterSpacing: 0.6,
        ),
      ),
    );
  }
}

/// Environment information panel for the admin dashboard. Shows identifiers
/// only; the server never sends keys or passwords.
class EnvironmentStatusCard extends StatefulWidget {
  const EnvironmentStatusCard({super.key, required this.load});

  final Future<EnvironmentStatus> Function() load;

  @override
  State<EnvironmentStatusCard> createState() => _EnvironmentStatusCardState();
}

class _EnvironmentStatusCardState extends State<EnvironmentStatusCard> {
  EnvironmentStatus? _status;
  String? _error;
  bool _loading = true;

  @override
  void initState() {
    super.initState();
    _refresh();
  }

  Future<void> _refresh() async {
    setState(() {
      _loading = true;
      _error = null;
    });
    try {
      final status = await widget.load();
      if (!mounted) return;
      setState(() {
        _status = status;
        _loading = false;
      });
    } on Object catch (error) {
      if (!mounted) return;
      setState(() {
        _error = error is EnvironmentStatusException
            ? error.message
            : 'Environment details are unavailable right now.';
        _loading = false;
      });
    }
  }

  String _label(AppEnvironmentKind? kind) => switch (kind) {
    AppEnvironmentKind.test => 'TEST',
    AppEnvironmentKind.live => 'LIVE / PRODUCTION',
    null => 'Not set',
  };

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final status = _status;
    final isTest = status?.environment == AppEnvironmentKind.test;
    return Card(
      key: const ValueKey('environment-status-card'),
      shape: RoundedRectangleBorder(
        borderRadius: BorderRadius.circular(16),
        side: BorderSide(
          color: isTest ? testModeOrange : theme.colorScheme.outlineVariant,
          width: isTest ? 2 : 1,
        ),
      ),
      child: Padding(
        padding: const EdgeInsets.all(16),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Row(
              children: [
                Expanded(
                  child: Text(
                    'Environment',
                    style: theme.textTheme.titleMedium,
                  ),
                ),
                IconButton(
                  tooltip: 'Check again',
                  onPressed: _loading ? null : _refresh,
                  icon: const Icon(Icons.refresh_rounded),
                ),
              ],
            ),
            if (_loading)
              const LinearProgressIndicator()
            else if (_error != null)
              Text(_error!, style: theme.textTheme.bodyMedium)
            else if (status != null) ...[
              if (isTest)
                Padding(
                  padding: const EdgeInsets.only(bottom: 8),
                  child: Text(
                    'All records in this environment are test records.',
                    style: theme.textTheme.bodyMedium?.copyWith(
                      fontWeight: FontWeight.w700,
                    ),
                  ),
                ),
              _row('Current environment', _label(status.environment)),
              _row('Database provider', status.databaseProvider),
              _row(
                'Database / project',
                status.databaseProjectRef ?? 'Unknown',
              ),
              _row('Database marker', _label(status.databaseMarker)),
              _row('Connection', status.databaseStatus),
              _row('Application URL', status.applicationUrl ?? 'Unknown'),
              _row('Payment gateway mode', switch (status.paymentGatewayMode) {
                'test' => 'Yoco TEST',
                'live' => 'Yoco LIVE',
                _ => 'Not configured',
              }),
              _row('Authentication', status.authEnvironment ?? 'Unknown'),
              _row(
                'Last database check',
                status.lastDatabaseCheckAt
                        ?.toLocal()
                        .toString()
                        .split('.')
                        .first ??
                    'Never',
              ),
              for (final issue in status.issues)
                Padding(
                  padding: const EdgeInsets.only(top: 6),
                  child: Text(issue, style: theme.textTheme.bodySmall),
                ),
            ],
          ],
        ),
      ),
    );
  }

  Widget _row(String label, String value) => Padding(
    padding: const EdgeInsets.symmetric(vertical: 3),
    child: Row(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        SizedBox(width: 160, child: Text(label)),
        Expanded(
          child: Text(
            value,
            style: const TextStyle(fontWeight: FontWeight.w600),
          ),
        ),
      ],
    ),
  );
}
