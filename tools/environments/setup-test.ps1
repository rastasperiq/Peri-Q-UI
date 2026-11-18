# One-off: build the EMPTY new TEST project (schema, TEST marker, demo data).
# Run it in your own PowerShell window. It asks for the TEST connection string
# and a demo-account password; neither is printed, saved or sent anywhere else,
# and both are cleared from this window at the end.
#
#   powershell -ExecutionPolicy Bypass -File tools\environments\setup-test.ps1
#   ... -SeedOnly   when the schema is already loaded (demo data only)

param([switch]$SeedOnly)

$ErrorActionPreference = 'Stop'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$node = 'C:\Users\Tlotla\Documents\Codex\2026-10-21\c\work\node-v26.13.1-win-x64'
if (Test-Path (Join-Path $node 'node.exe')) { $env:Path = "$node;$env:Path" }
if (-not (Get-Command node -ErrorAction SilentlyContinue)) { throw 'Node.js is not available.' }

function Read-Secret([string]$prompt) {
    $secure = Read-Host $prompt -AsSecureString
    $bstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
    try { [Runtime.InteropServices.Marshal]::PtrToStringBSTR($bstr) }
    finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr) }
}

Write-Host ''
Write-Host 'Supabase -> project "Peri Q TEST" -> Connect -> Session pooler -> copy the URI,' -ForegroundColor Cyan
Write-Host 'with your database password in place of [YOUR-PASSWORD].' -ForegroundColor Cyan
try {
    $env:PERIQ_TEST_DB_URL = Read-Secret 'TEST connection string (hidden)'
    $env:PERIQ_TEST_DEMO_PASSWORD = Read-Secret 'Password for the demo accounts, 12+ characters (hidden)'
    Push-Location $here
    try {
        if (-not (Test-Path (Join-Path $here 'node_modules\pg'))) { npx --yes pnpm@11.9.0 install }
        if (-not $SeedOnly) {
            node db.mjs init-test
            if ($LASTEXITCODE -ne 0) { throw 'init-test stopped (see the message above).' }
        }
        node db.mjs seed-test
        if ($LASTEXITCODE -ne 0) { throw 'seed-test stopped (see the message above).' }
        node db.mjs status --env test
    } finally {
        Pop-Location
    }
    Write-Host ''
    Write-Host 'TEST database ready.' -ForegroundColor Green
} finally {
    Remove-Item Env:PERIQ_TEST_DB_URL, Env:PERIQ_TEST_DEMO_PASSWORD -ErrorAction SilentlyContinue
}
