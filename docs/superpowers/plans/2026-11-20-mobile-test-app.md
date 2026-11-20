# Mobile TEST app Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans. Steps use checkbox (`- [ ]`) syntax.

**Goal:** a separate "RastasperiQ TEST" Android app built against the TEST database and staging site.

**Architecture:** Android product flavours `live`/`test`; the release script gains `-Environment`; the staging website points its app-return link at the TEST package.

**Tech Stack:** Flutter, Gradle Kotlin DSL, PowerShell, Next.js (vitest).

**Spec:** `docs/superpowers/specs/2026-11-20-mobile-test-app-design.md`

## Global Constraints

- Live ID stays `za.co.rastasperiq.ordering`, label "RastasperiQ"; test ID `za.co.rastasperiq.ordering.test`, label "RastasperiQ TEST".
- Live output names unchanged: `rastasperiq-v<name>-build<code>-closed-test-release.{apk,aab}`.
- Never commit `release-config*.json` (non-example), `key.properties`, keystores.
- LIVE Supabase ref `ovqvytkhznhmlxsfaqwh` and host `rastasperiq.co.za` (without `staging.`) are refused by TEST builds.

## Review Focus

- `flutter run` without `--flavor` fails once flavours exist → README says `flutter run --flavor test` / `--flavor live`.
- Test build without `src/test/google-services.json` → script stops with a plain message saying how to get it.
- `release-config.test.json` copied from LIVE values → script refuses (ref / host checks).
- Live site payment return must still name the live package → unit test.
- Missing `release-config.test.json` → plain message pointing at the example file.

---

### Task 1: Website return link names the right package

**Files:** Modify `website/app/payment/[id]/payment-status.tsx`, `website/app/payment/[id]/page.tsx`; Test `website/tests/payment-status.test.tsx`

- [ ] Test: `appReturnLink("x","success","Android",undefined,"za.co.rastasperiq.ordering.test")` contains `package=za.co.rastasperiq.ordering.test;`; default call still contains `package=za.co.rastasperiq.ordering;`.
- [ ] Implement: `appReturnLink(orderId, result, userAgent, fallbackUrl?, appPackage = LIVE_APP_PACKAGE)`; `PaymentStatus` takes optional `appPackage` prop; `page.tsx` passes `currentEnvironment() === "test" ? TEST_APP_PACKAGE : LIVE_APP_PACKAGE`.
- [ ] Run vitest, tsc, eslint.

### Task 2: Android flavours

**Files:** Modify `peri_q_app/android/app/build.gradle.kts`, `peri_q_app/android/app/src/main/AndroidManifest.xml`

- [ ] `flavorDimensions += "environment"`; `live` with `manifestPlaceholders["appLabel"]="RastasperiQ"`; `test` with `applicationIdSuffix=".test"`, `manifestPlaceholders["appLabel"]="RastasperiQ TEST"`. Manifest `android:label="${appLabel}"`.
- [ ] Verify: `flutter build apk --debug --flavor live` succeeds (if disk space allows).

### Task 3: Release script `-Environment`

**Files:** Modify `peri_q_app/tool/build_android_release.ps1`, `peri_q_app/README.md`

- [ ] `-Environment live|test` (default live). Live: as today plus `--flavor live`, copying from `app-live-release.apk` / `bundle/liveRelease/app-live-release.aab`.
- [ ] Test: config `release-config.test.json`; require `android/app/src/test/google-services.json`; checks from Global Constraints; APK only; all config keys passed as `--dart-define`; signing optional; output `rastasperiq-TEST-v<name>-build<code>.apk`.
- [ ] README: build commands, `flutter run --flavor`, Firebase step.
- [ ] Commit.
