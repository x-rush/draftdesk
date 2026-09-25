param(
  [Parameter(Mandatory)][ValidateSet('openclaw', 'hermes')][string]$Agent,
  [string]$ResultPath,
  [string]$ResponseFile,
  [Parameter(Mandatory)][string]$CredentialFile,
  [string]$WorkspaceUrl = 'http://127.0.0.1:5173'
)
$ErrorActionPreference = 'Stop'
# The agent writes an evidence package. This trusted adapter holds the scoped
# credential, so unattended agents never need shell approval or key access.
$uri = [Uri]$WorkspaceUrl
if ($uri.Scheme -ne 'https' -and !($uri.Scheme -eq 'http' -and $uri.Host -in @('localhost','127.0.0.1'))) {
  throw 'Use HTTPS for a remote workspace.'
}
if ($uri.UserInfo -or $uri.Query -or $uri.Fragment -or $uri.AbsolutePath -ne '/') { throw 'WorkspaceUrl must be a base origin.' }
if ([bool]$ResultPath -eq [bool]$ResponseFile) { throw 'Specify exactly one of ResultPath or ResponseFile.' }
if ($ResultPath -and !$ResultPath.StartsWith('/')) { throw 'ResultPath must be an absolute path inside the agent container.' }
$credential = Get-Content -LiteralPath $CredentialFile -Raw | ConvertFrom-Json
if (!$credential.token) { throw 'Credential file has no scoped token.' }
$temporary = [IO.Path]::GetTempFileName()
try {
  if ($ResultPath) {
    docker cp "draftdesk-agents-${Agent}-1:$ResultPath" $temporary
    if ($LASTEXITCODE -ne 0) { throw 'Could not read the agent output file.' }
    $payload = Get-Content -LiteralPath $temporary -Raw
  } else {
    $response = Get-Content -LiteralPath $ResponseFile -Raw
    try { $outer = $response | ConvertFrom-Json -ErrorAction Stop } catch { $outer = $null }
    if ($outer.result.payloads) {
      if ($outer.status -ne 'ok') { throw 'Agent run did not complete successfully.' }
      $response = $outer.result.payloads[0].text
    }
    if ($response -match '(?s)```json\s*(\{.*?\})\s*```') { $response = $Matches[1] }
    $payload = $response
  }
  if ([Text.Encoding]::UTF8.GetByteCount($payload) -gt 1000000) { throw 'Evidence package exceeds 1 MB.' }
  $value = $payload | ConvertFrom-Json
  if ($value.schemaVersion -ne '1.0' -or !$value.submissionId -or !$value.evidence) { throw 'Invalid evidence package.' }
  $dateOnly = 0
  foreach ($item in $value.evidence) {
    if ($item.publishedAt -match '^\d{4}-\d{2}-\d{2}$') {
      $item.PSObject.Properties.Remove('publishedAt')
      $dateOnly++
    }
  }
  if ($dateOnly) {
    # A date-only search result does not establish a publication time. Keep it
    # in the excerpt and omit the optional timestamp rather than inventing one.
    $payload = $value | ConvertTo-Json -Depth 30 -Compress
    Write-Warning "Omitted $dateOnly date-only publishedAt value(s); the source excerpt remains available for review."
  }
  # A submissionId such as "draftdesk-config-..." contains "sk-" across the
  # word boundary. Only flag a key prefix that starts a separate token.
  if ($payload -match '(?i)(?:(?<![A-Za-z0-9_-])sk-[A-Za-z0-9_-]{20,}|Bearer\s+[A-Za-z0-9._-]{20,}|(?:cookie|authorization)\s*[:=])') { throw 'Possible credential in evidence package.' }
  $check = Invoke-RestMethod -Uri ($WorkspaceUrl.TrimEnd('/') + '/api/v1/intake-check') -Method Post -ContentType 'application/json; charset=utf-8' -Headers @{Authorization="Bearer $($credential.token)"} -Body ([Text.Encoding]::UTF8.GetBytes($payload))
  if (!$check.ok) { throw 'Evidence package failed intake preflight.' }
  $receipt = Invoke-RestMethod -Uri ($WorkspaceUrl.TrimEnd('/') + '/api/v1/intake') -Method Post -ContentType 'application/json; charset=utf-8' -Headers @{Authorization="Bearer $($credential.token)"} -Body ([Text.Encoding]::UTF8.GetBytes($payload))
  $receipt | ConvertTo-Json -Depth 8
} finally {
  Remove-Item -LiteralPath $temporary -ErrorAction SilentlyContinue
}
