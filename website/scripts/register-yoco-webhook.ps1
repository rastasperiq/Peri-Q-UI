# LIVE:  powershell -ExecutionPolicy Bypass -File website\scripts\register-yoco-webhook.ps1
# TEST:  ... -WebhookUrl https://staging.rastasperiq.co.za/api/yoco/webhook/ -Name rastasperiq-staging
param(
    [string]$WebhookUrl = 'https://rastasperiq.co.za/api/yoco/webhook/',
    [string]$Name = 'rastasperiq-website'
)
$ErrorActionPreference = 'Stop'
$isProduction = $WebhookUrl -eq 'https://rastasperiq.co.za/api/yoco/webhook/'
Write-Host "Register the RastasperiQ webhook with Yoco for $WebhookUrl"
$secureYocoKey = Read-Host 'Yoco secret key (input is hidden)' -AsSecureString
$yocoKeyValue = [System.Net.NetworkCredential]::new('', $secureYocoKey).Password
try {
    if ($yocoKeyValue -notmatch '^sk_(test|live)_') { throw 'Enter a Yoco secret key starting sk_test_ or sk_live_. A public key cannot register webhooks.' }
    if (-not $isProduction -and $yocoKeyValue -match '^sk_live_') { throw 'Refusing: a LIVE key can only register the production webhook. Use your TEST key for staging.' }
    if ($WebhookUrl -notmatch '^https://[^/]+/api/yoco/webhook/$') { throw 'The webhook URL must be https://<host>/api/yoco/webhook/' }
    $registrationBody = @{
        name = $Name
        url = $WebhookUrl
    } | ConvertTo-Json
    $registration = Invoke-RestMethod -Method Post -Uri 'https://payments.yoco.com/api/webhooks' -Headers @{ Authorization = "Bearer $yocoKeyValue" } -ContentType 'application/json' -Body $registrationBody
    if (!$registration.secret) { throw 'Yoco did not return a webhook secret. Inspect your Yoco account before registering again.' }
    $project = if ($isProduction) { 'the LIVE Vercel project (peri-q-ui)' } else { 'the STAGING Vercel project (peri-q-ui-staging)' }
    Write-Host "Webhook registered. Copy this secret into $project as YOCO_WEBHOOK_SECRET:"
    Write-Host $registration.secret
    Write-Host 'Keep the secret private. Yoco provides it only once. Redeploy Vercel after saving it.'
} finally {
    $yocoKeyValue = $null
    $secureYocoKey = $null
}
Read-Host 'Press Enter after saving the webhook secret'
