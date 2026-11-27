param(
    [ValidateSet('apk', 'appbundle', 'all')]
    [string]$Target = 'all',

    # live: the Play Store app (release-config.json, must be signed).
    # test: the separate "RastasperiQ TEST" app (release-config.test.json),
    #       built against the TEST database and staging site. APK only.
    [ValidateSet('live', 'test')]
    [string]$Environment = 'live'
)

$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
$pubspecPath = Join-Path $projectRoot 'pubspec.yaml'
$signingConfigPath = Join-Path $projectRoot 'android\key.properties'
$liveSupabaseRef = 'ovqvytkhznhmlxsfaqwh'
$isTest = $Environment -eq 'test'
# Android refuses flavour names that start with "test".
$flavor = if ($isTest) { 'staging' } else { 'live' }

if ($isTest) {
    $releaseConfigPath = Join-Path $projectRoot 'release-config.test.json'
    if (-not (Test-Path -LiteralPath $releaseConfigPath)) {
        throw "Missing $releaseConfigPath. Copy release-config.test.example.json to release-config.test.json and fill in the TEST Supabase URL and publishable key."
    }
    $testFirebasePath = Join-Path $projectRoot 'android\app\src\staging\google-services.json'
    if (-not (Test-Path -LiteralPath $testFirebasePath)) {
        throw "Missing $testFirebasePath. In Firebase (project rastas-peri-q) add an Android app with package za.co.rastasperiq.ordering.test, download its google-services.json and save it there."
    }
    if ($Target -ne 'apk') {
        Write-Host 'TEST builds are APK only (never uploaded to Play); building the APK.'
        $Target = 'apk'
    }
}
else {
    $releaseConfigPath = Join-Path $projectRoot 'release-config.json'
    if (-not (Test-Path -LiteralPath $releaseConfigPath)) {
        throw "Missing ignored release configuration: $releaseConfigPath"
    }
    if (-not (Test-Path -LiteralPath $signingConfigPath)) {
        throw "Missing ignored Android signing configuration: $signingConfigPath"
    }
}

$releaseConfig = Get-Content -Raw -LiteralPath $releaseConfigPath |
    ConvertFrom-Json
$supabaseUrl = [string]$releaseConfig.SUPABASE_URL
$supabasePublishableKey = [string]$releaseConfig.SUPABASE_PUBLISHABLE_KEY

if ([string]::IsNullOrWhiteSpace($supabaseUrl) -or
    [string]::IsNullOrWhiteSpace($supabasePublishableKey)) {
    throw 'Release configuration is missing required Supabase values.'
}

$defines = [ordered]@{
    SUPABASE_URL             = $supabaseUrl
    SUPABASE_PUBLISHABLE_KEY = $supabasePublishableKey
}

if ($isTest) {
    # A TEST app must never reach the LIVE database, live site or live payments.
    if ([string]$releaseConfig.APP_ENVIRONMENT -ne 'test') {
        throw 'release-config.test.json must contain "APP_ENVIRONMENT": "test".'
    }
    if ($supabaseUrl -match $liveSupabaseRef) {
        throw 'release-config.test.json points at the LIVE Supabase project. Use the TEST project URL and key.'
    }
    $defines['APP_ENVIRONMENT'] = 'test'
    foreach ($name in 'CARD_CHECKOUT_URL', 'DELIVERY_QUOTE_URL', 'ENVIRONMENT_STATUS_URL') {
        $value = [string]$releaseConfig.$name
        if ([string]::IsNullOrWhiteSpace($value)) {
            throw "release-config.test.json is missing $name (see release-config.test.example.json)."
        }
        $uri = [Uri]$value
        if ($uri.Host -eq 'rastasperiq.co.za' -or $uri.Host -eq 'www.rastasperiq.co.za') {
            throw "$name points at the live site. Use https://staging.rastasperiq.co.za/..."
        }
        $defines[$name] = $value
    }
}
else {
    # The Play Store app must never ship with an old or TEST database.
    if ($supabaseUrl.Trim().TrimEnd('/') -ne "https://$liveSupabaseRef.supabase.co") {
        throw "release-config.json must use the LIVE Supabase project (https://$liveSupabaseRef.supabase.co), not $supabaseUrl."
    }
    if ([string]$releaseConfig.APP_ENVIRONMENT -eq 'test') {
        throw 'release-config.json must not contain "APP_ENVIRONMENT": "test".'
    }
}

$versionLine = Select-String -LiteralPath $pubspecPath -Pattern '^version:\s*(?<name>[^+]+)\+(?<code>\d+)\s*$' |
    Select-Object -First 1

if ($null -eq $versionLine) {
    throw "Could not parse Flutter version from $pubspecPath"
}

$buildName = $versionLine.Matches[0].Groups['name'].Value.Trim()
$buildNumber = $versionLine.Matches[0].Groups['code'].Value.Trim()
$releaseOutputPath = Join-Path $projectRoot 'release\android'
if ($isTest) {
    $releaseStem = "rastasperiq-TEST-v$buildName-build$buildNumber"
    $symbolsPath = Join-Path $releaseOutputPath "symbols-TEST-v$buildName-build$buildNumber"
}
else {
    $releaseStem = "rastasperiq-v$buildName-build$buildNumber-closed-test-release"
    $symbolsPath = Join-Path $releaseOutputPath "symbols-v$buildName-build$buildNumber-closed-test"
}

$commonArguments = @(
    '--release',
    '--no-pub',
    "--flavor=$flavor",
    '--obfuscate',
    "--split-debug-info=$symbolsPath"
)
foreach ($entry in $defines.GetEnumerator()) {
    $commonArguments += "--dart-define=$($entry.Key)=$($entry.Value)"
}

Push-Location $projectRoot
try {
    New-Item -ItemType Directory -Path $releaseOutputPath -Force | Out-Null

    if ($Target -in @('apk', 'all')) {
        & flutter build apk @commonArguments
        if ($LASTEXITCODE -ne 0) {
            exit $LASTEXITCODE
        }
        Copy-Item -LiteralPath (Join-Path $projectRoot "build\app\outputs\flutter-apk\app-$flavor-release.apk") `
            -Destination (Join-Path $releaseOutputPath "$releaseStem.apk") -Force
    }
    if ($Target -in @('appbundle', 'all')) {
        & flutter build appbundle @commonArguments
        if ($LASTEXITCODE -ne 0) {
            exit $LASTEXITCODE
        }
        Copy-Item -LiteralPath (Join-Path $projectRoot "build\app\outputs\bundle\${flavor}Release\app-$flavor-release.aab") `
            -Destination (Join-Path $releaseOutputPath "$releaseStem.aab") -Force
    }
    Write-Host "Built $Environment output in $releaseOutputPath"
}
finally {
    Pop-Location
}
