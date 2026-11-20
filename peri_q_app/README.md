# RastasperiQ

Production-oriented Flutter/Supabase ordering app for a single local store.

## Two apps: LIVE and TEST

The Android project has two flavours that install side by side:

| Flavour | App name | Package | Talks to |
|---|---|---|---|
| `live` | RastasperiQ | `za.co.rastasperiq.ordering` | LIVE database, rastasperiq.co.za, real payments |
| `test` | RastasperiQ TEST | `za.co.rastasperiq.ordering.test` | TEST database, staging.rastasperiq.co.za, Yoco test mode |

Every `flutter run` / `flutter build` needs `--flavor live` or `--flavor test`.

## Run locally

1. Install Flutter 3.44+, Java 21 and Android SDK/API 36.
2. Supply Supabase values as compile-time defines (do not bundle `.env`):

```bash
flutter pub get
flutter run --flavor test --dart-define-from-file=release-config.test.json
```

## Quality gates

```bash
dart format --output=none --set-exit-if-changed lib test
flutter analyze
flutter test
```

## Build the TEST app (APK for a test phone)

One-time setup:

1. Copy `release-config.test.example.json` to `release-config.test.json` (ignored by git) and fill in the TEST Supabase URL and publishable key.
2. In the Firebase console (project `rastas-peri-q`) add an Android app with package `za.co.rastasperiq.ordering.test`, download its `google-services.json` and save it as `android/app/src/test/google-services.json`.

Then:

```powershell
.\tool\build_android_release.ps1 -Environment test
```

Output: `release/android/rastasperiq-TEST-v<version>-build<code>.apk`. The script refuses to build if the config points at the LIVE database or the live site. Without `android/key.properties` the TEST APK is debug-signed, which is fine for sideloading. Push notifications for TEST orders are not set up yet.

## Build the LIVE app (Play Store)

```powershell
.\tool\build_android_release.ps1 -Environment live -Target all
```

Needs the ignored `release-config.json` and `android/key.properties`. Output names are unchanged: `release/android/rastasperiq-v<version>-build<code>-closed-test-release.{apk,aab}`.

Read `docs/ANDROID_SIGNING_GUIDE.md`, `docs/FINAL_RELEASE_REPORT.md` and `docs/GOOGLE_PLAY_RELEASE_CHECKLIST.md`. Apply `supabase/schema.sql` to staging/production before testing order placement. Never use a service-role key in the app.

The checked-in release configuration targets API 36, shrinks resources/code, and uses a permanent candidate application ID. Without ignored `android/key.properties`, live release output is intentionally unsigned.

## Endpoints

`CARD_CHECKOUT_URL`, `DELIVERY_QUOTE_URL` and `ENVIRONMENT_STATUS_URL` are public HTTPS endpoints, not secrets; the defaults are the live site and the TEST build passes the staging ones. Embedded credentials, query strings, fragments and cleartext HTTP are rejected. The payment backend and Supabase project must match. Never embed server secrets in the app.
