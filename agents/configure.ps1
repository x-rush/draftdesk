param(
  [switch]$SkipSkillSync
)
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$envPath = Join-Path $PSScriptRoot '.env'
if (!(Test-Path -LiteralPath $envPath)) { throw 'Copy agents/.env.example to agents/.env and configure Bailian first.' }
$envText = [IO.File]::ReadAllText($envPath)
if ($envText -notmatch '(?m)^BAILIAN_API_KEY=.{12,}$') { throw 'BAILIAN_API_KEY is missing in agents/.env.' }
if ($envText -notmatch '(?m)^BAILIAN_BASE_URL=https://[^\s]+\r?$') { throw 'BAILIAN_BASE_URL must be an HTTPS URL in agents/.env.' }
if ($envText -notmatch '(?m)^BAILIAN_MODEL=\S+\r?$') { throw 'BAILIAN_MODEL is missing in agents/.env.' }

# The sample gateway token is unsafe even when published ports bind to loopback.
$tokenLine = [regex]::Match($envText, '(?m)^OPENCLAW_GATEWAY_TOKEN=(.*)$')
if (!$tokenLine.Success -or $tokenLine.Groups[1].Value.TrimEnd("`r").Length -lt 32 -or $tokenLine.Groups[1].Value.TrimEnd("`r") -in @('change-me', 'replace-with-a-long-random-token', '')) {
  $bytes = New-Object byte[] 32
  [Security.Cryptography.RandomNumberGenerator]::Fill($bytes)
  $token = [Convert]::ToHexString($bytes).ToLowerInvariant()
  if ($tokenLine.Success) {
    $envText = [regex]::Replace($envText, '(?m)^OPENCLAW_GATEWAY_TOKEN=.*$', ('OPENCLAW_GATEWAY_TOKEN=' + $token))
  } else {
    $envText = $envText.TrimEnd() + "`nOPENCLAW_GATEWAY_TOKEN=$token`n"
  }
  [IO.File]::WriteAllText($envPath, $envText, (New-Object Text.UTF8Encoding($false)))
  Write-Output 'Generated a random local OpenClaw gateway token in ignored agents/.env.'
}

function Invoke-Docker([string[]]$DockerArgs) {
  & docker @DockerArgs
  if ($LASTEXITCODE -ne 0) { throw "Docker command failed (exit $LASTEXITCODE)." }
}

Push-Location $root
try {
  Invoke-Docker -DockerArgs @('compose', '-f', 'agents/compose.yaml', 'up', '-d')
  & docker exec draftdesk-agents-openclaw-1 sh -lc 'test -d /home/node/.openclaw/extensions/searxng'
  if ($LASTEXITCODE -ne 0) {
    Invoke-Docker -DockerArgs @('exec', 'draftdesk-agents-openclaw-1', 'node', 'openclaw.mjs', 'plugins', 'install', '@openclaw/searxng-plugin')
  }
  Invoke-Docker -DockerArgs @('exec', 'draftdesk-agents-openclaw-1', 'node', 'openclaw.mjs', 'config', 'set', 'tools.web.search.provider', 'searxng')
  Invoke-Docker -DockerArgs @('exec', 'draftdesk-agents-openclaw-1', 'node', 'openclaw.mjs', 'config', 'set', 'plugins.entries.searxng.config.webSearch.baseUrl', 'http://searxng:8080')
  Invoke-Docker -DockerArgs @('exec', 'draftdesk-agents-openclaw-1', 'node', 'openclaw.mjs', 'config', 'set', 'agents.defaults.heartbeat.every', '0m')
  # Older root-run migrations may have created backups the Hermes user cannot update.
  Invoke-Docker -DockerArgs @('exec', '-u', '0', 'draftdesk-agents-hermes-1', 'mkdir', '-p', '/opt/data/backups/config')
  Invoke-Docker -DockerArgs @('exec', '-u', '0', 'draftdesk-agents-hermes-1', 'chown', '-R', '10000:10000', '/opt/data/backups/config')
  Invoke-Docker -DockerArgs @('exec', '-u', '10000:10000', 'draftdesk-agents-hermes-1', '/opt/hermes/.venv/bin/hermes', 'config', 'migrate')
  Invoke-Docker -DockerArgs @('exec', '-u', '10000:10000', 'draftdesk-agents-hermes-1', '/opt/hermes/.venv/bin/hermes', 'config', 'set', 'web.search_backend', 'searxng')
  Invoke-Docker -DockerArgs @('exec', '-u', '10000:10000', 'draftdesk-agents-hermes-1', '/opt/hermes/.venv/bin/hermes', 'config', 'set', 'web.extract_backend', 'exa')
  if (!$SkipSkillSync) {
    Invoke-Docker -DockerArgs @('cp', 'skills/.', 'draftdesk-agents-openclaw-1:/home/node/.openclaw/skills/')
    Invoke-Docker -DockerArgs @('cp', 'skills/.', 'draftdesk-agents-hermes-1:/opt/data/skills/')
    Invoke-Docker -DockerArgs @('exec', '-u', '0', 'draftdesk-agents-openclaw-1', 'chown', '-R', '1000:1000', '/home/node/.openclaw/skills')
    Invoke-Docker -DockerArgs @('exec', '-u', '0', 'draftdesk-agents-hermes-1', 'chown', '-R', '10000:10000', '/opt/data/skills')
  }
  $health = (Invoke-Docker -DockerArgs @('exec', 'draftdesk-agents-openclaw-1', 'node', 'openclaw.mjs', 'health', '--json')) | ConvertFrom-Json
  if (!$health.ok -or 'searxng' -notin $health.plugins.loaded -or $health.heartbeatSeconds -ne 0) {
    throw 'OpenClaw health, SearXNG plugin, or heartbeat check failed.'
  }
  $search = (Invoke-Docker -DockerArgs @('exec', 'draftdesk-agents-hermes-1', '/opt/hermes/.venv/bin/hermes', 'config', 'get', 'web.search_backend')) -join ''
  $extract = (Invoke-Docker -DockerArgs @('exec', 'draftdesk-agents-hermes-1', '/opt/hermes/.venv/bin/hermes', 'config', 'get', 'web.extract_backend')) -join ''
  if ($search.Trim() -ne 'searxng' -or $extract.Trim() -ne 'exa') { throw 'Hermes web provider check failed.' }
  Invoke-Docker -DockerArgs @('exec', 'draftdesk-agents-openclaw-1', 'node', '-e', "fetch('http://searxng:8080/').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))")
  Write-Output 'Agent configuration applied. Model, live search, extraction, and DraftDesk intake still require the acceptance checks in agents/README.md.'
} finally {
  Pop-Location
}
