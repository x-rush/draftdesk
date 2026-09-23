param(
  [Parameter(Mandatory)][ValidateSet('openclaw', 'hermes')][string]$Agent,
  [Parameter(Mandatory)][string]$ResultPath,
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
if (!$ResultPath.StartsWith('/')) { throw 'ResultPath must be an absolute path inside the agent container.' }
$credential = Get-Content -LiteralPath $CredentialFile -Raw | ConvertFrom-Json
if (!$credential.token) { throw 'Credential file has no scoped token.' }
$temporary = [IO.Path]::GetTempFileName()
try {
  docker cp "draftdesk-agents-${Agent}-1:$ResultPath" $temporary
  if ($LASTEXITCODE -ne 0) { throw 'Could not read the agent output file.' }
  $payload = Get-Content -LiteralPath $temporary -Raw
  if ([Text.Encoding]::UTF8.GetByteCount($payload) -gt 1000000) { throw 'Evidence package exceeds 1 MB.' }
  $value = $payload | ConvertFrom-Json
  if ($value.schemaVersion -ne '1.0' -or !$value.submissionId -or !$value.evidence) { throw 'Invalid evidence package.' }
  $receipt = Invoke-RestMethod -Uri ($WorkspaceUrl.TrimEnd('/') + '/api/v1/intake') -Method Post -ContentType 'application/json; charset=utf-8' -Headers @{Authorization="Bearer $($credential.token)"} -Body ([Text.Encoding]::UTF8.GetBytes($payload))
  $receipt | ConvertTo-Json -Depth 8
} finally {
  Remove-Item -LiteralPath $temporary -ErrorAction SilentlyContinue
}
