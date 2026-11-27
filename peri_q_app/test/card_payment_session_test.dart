import 'package:flutter_test/flutter_test.dart';
import 'package:peri_q_app/src/core/payment_session.dart';

void main() {
  final session = CardPaymentSession.instance;

  tearDown(session.finish);

  group('Payment return links', () {
    test('reads success, cancel and failure returns for an order', () {
      final success = CardPaymentSession.parseReturnLink(
        Uri.parse('rastasperiq://payment-return?order=abc&result=success'),
      );
      expect(success?.orderId, 'abc');
      expect(success?.result, PaymentReturnResult.success);
      expect(
        CardPaymentSession.parseReturnLink(
          Uri.parse('rastasperiq://payment-return?order=abc&result=cancel'),
        )?.result,
        PaymentReturnResult.cancelled,
      );
      expect(
        CardPaymentSession.parseReturnLink(
          Uri.parse('rastasperiq://payment-return?order=abc&result=failure'),
        )?.result,
        PaymentReturnResult.failed,
      );
    });

    test('ignores other links and incomplete returns', () {
      for (final link in [
        'rastasperiq://reset-password?code=abc',
        'https://rastasperiq.co.za/payment-return?order=abc&result=success',
        'rastasperiq://payment-return?result=success',
        'rastasperiq://payment-return?order=abc&result=paid',
      ]) {
        expect(
          CardPaymentSession.parseReturnLink(Uri.parse(link)),
          isNull,
          reason: link,
        );
      }
    });
  });

  group('Hosted payment returns', () {
    test('reads where the payment page sends the customer for this order', () {
      final success = CardPaymentSession.parseHostedReturn(
        Uri.parse(
          'https://rastasperiq.co.za/payment/abc/?checkout=success&source=mobile',
        ),
        orderId: 'abc',
      );
      expect(success?.orderId, 'abc');
      expect(success?.result, PaymentReturnResult.success);
      expect(
        CardPaymentSession.parseHostedReturn(
          Uri.parse('https://rastasperiq.co.za/payment/abc?checkout=cancel'),
          orderId: 'abc',
        )?.result,
        PaymentReturnResult.cancelled,
      );
      expect(
        CardPaymentSession.parseHostedReturn(
          Uri.parse('https://rastasperiq.co.za/payment/abc/?checkout=failure'),
          orderId: 'abc',
        )?.result,
        PaymentReturnResult.failed,
      );
    });

    test('ignores the payment page itself and other orders', () {
      for (final link in [
        'https://c.yoco.com/checkout/ch_123',
        'https://rastasperiq.co.za/payment/other/?checkout=success',
        'https://rastasperiq.co.za/payment/abc/',
        'https://rastasperiq.co.za/payment/abc/?checkout=paid',
        'https://rastasperiq.co.za/order/abc/?checkout=success',
        'http://rastasperiq.co.za/payment/abc/?checkout=success',
        'https://rastasperiq.co.za.evil.example/payment/abc/?checkout=success',
        'https://evil.example/payment/abc/?checkout=success',
        'https://user@rastasperiq.co.za/payment/abc/?checkout=success',
      ]) {
        expect(
          CardPaymentSession.parseHostedReturn(Uri.parse(link), orderId: 'abc'),
          isNull,
          reason: link,
        );
      }
    });
  });

  test(
    'only HTTPS pages without credentials may open in the payment screen',
    () {
      expect(
        CardPaymentSession.isSecurePage(
          Uri.parse('https://c.yoco.com/checkout/1'),
        ),
        isTrue,
      );
      for (final link in [
        'http://c.yoco.com/checkout/1',
        'javascript:alert(1)',
        'intent://pay#Intent;end',
        'https://user:pass@c.yoco.com/checkout/1',
      ]) {
        expect(
          CardPaymentSession.isSecurePage(Uri.parse(link)),
          isFalse,
          reason: link,
        );
      }
    },
  );

  test('a TEST build accepts returns only from its own site', () {
    final staging = Uri.parse(
      'https://staging.rastasperiq.co.za/payment/abc/?checkout=success',
    );
    expect(
      CardPaymentSession.parseHostedReturn(
        staging,
        orderId: 'abc',
        site: 'staging.rastasperiq.co.za',
      ),
      isNotNull,
    );
    expect(
      CardPaymentSession.parseHostedReturn(
        staging,
        orderId: 'abc',
        site: 'rastasperiq.co.za',
      ),
      isNull,
    );
  });

  group('Payment session', () {
    tearDown(() => session.presenter = null);

    test('opens the payment page in the app screen when one is set', () async {
      final shown = <(Uri, String)>[];
      session.presenter = (url, orderId) async {
        shown.add((url, orderId));
        return true;
      };
      expect(await session.openPaymentPage(), isFalse);

      final url = Uri.parse('https://pay.example/checkout/1');
      session.opened(orderId: 'current', checkoutUrl: url);
      expect(await session.openPaymentPage(), isTrue);
      expect(shown, [(url, 'current')]);
    });

    test('passes returns only for the payment that is running', () async {
      final received = <PaymentReturn>[];
      final subscription = session.returns.listen(received.add);
      session.opened(
        orderId: 'current',
        checkoutUrl: Uri.parse('https://pay.example/checkout/1'),
      );
      expect(session.stage.value, CardPaymentStage.awaitingCustomer);

      session.report(
        const PaymentReturn(
          orderId: 'old-order',
          result: PaymentReturnResult.success,
        ),
      );
      session.abandon();
      await Future<void>.delayed(Duration.zero);

      expect(received, hasLength(1));
      expect(received.single.orderId, 'current');
      expect(received.single.result, PaymentReturnResult.abandoned);
      await subscription.cancel();
    });

    test('finishing clears the running payment', () {
      session.opened(
        orderId: 'current',
        checkoutUrl: Uri.parse('https://pay.example/checkout/1'),
      );
      session.finish();
      expect(session.activeOrderId, isNull);
      expect(session.checkoutUrl, isNull);
      expect(session.stage.value, CardPaymentStage.idle);
    });
  });
}
