# Mobile TEST app (short design)

**Why:** the owner wants to try the Android app against the TEST database and
staging site (Yoco test mode) without touching real orders, and keep the real
app installed on the same phone.

**Goals:** a separate "RastasperiQ TEST" app (`za.co.rastasperiq.ordering.test`)
that installs beside the live app; one build command for it; the live build
unchanged in what it produces.

**Non-goals:** Play Store upload of the TEST app (APK only); push notifications
for TEST orders (needs FCM setup on the TEST database; later); iOS.

**Anti-goals:** a TEST build that can reach the LIVE database or live payments;
breaking or renaming the live AAB/APK.

## Approaches

- **A. Separate TEST app via an Android flavour (chosen).** `live` and `test`
  flavours; `test` adds `.test` to the ID and the name "RastasperiQ TEST". Needs
  a Firebase Android app for the new ID (owner adds it, ~2 min).
- B. Same app ID with TEST settings: no Firebase work, but installing it
  replaces the live app. Rejected by the owner.

## Design

- `android/app/build.gradle.kts`: flavour dimension `environment`; `live`
  (no suffix, label "RastasperiQ"), `test` (`applicationIdSuffix ".test"`,
  label "RastasperiQ TEST"). Manifest label comes from a placeholder.
- Firebase: live keeps `android/app/google-services.json`; test reads
  `android/app/src/test/google-services.json` (owner downloads it; it holds no
  secrets, same as the live one).
- `tool/build_android_release.ps1 -Environment live|test`:
  - live (default): `release-config.json`, `--flavor live`, same output names
    as today; requires signing as today.
  - test: `release-config.test.json`, `--flavor test`, APK only, passes every
    value in the config (APP_ENVIRONMENT, Supabase, checkout/delivery/
    environment URLs) as dart-defines; refuses to build if APP_ENVIRONMENT is
    not `test`, if the Supabase URL is the LIVE project, or if any URL points
    at the live site. Output `rastasperiq-TEST-v…apk`. Signs with the release
    key when present, otherwise debug-signed (fine for a test phone).
- Deep links keep the `rastasperiq` scheme. The website's payment-return
  intent link names the app package; the staging site (APP_ENVIRONMENT=test)
  names `…ordering.test`, the live site stays as today.

**Builder's calls:** debug signing fallback for TEST; scheme left shared
(password-reset links may show an "open with" choice when both apps are
installed).
