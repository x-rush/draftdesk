# DraftDesk external agents

This optional Compose project runs OpenClaw and Hermes separately from DraftDesk. From the DraftDesk repository root in PowerShell:

```powershell
Copy-Item agents/.env.example agents/.env
notepad agents/.env
docker compose -f search/compose.yaml up -d
docker compose -f agents/compose.yaml pull
./agents/configure.ps1
docker compose -f agents/compose.yaml ps
```

OpenClaw is at `http://127.0.0.1:18789/`. Hermes exposes its gateway at `http://127.0.0.1:8642/`. The optional Hermes dashboard is disabled by default. To use `http://127.0.0.1:9119/`, configure a dashboard auth provider before setting `HERMES_DASHBOARD=1`; a dashboard without authentication will refuse to start and repeatedly restart. All published ports are loopback-only.

Set the Bailian key, the exact OpenAI-compatible base URL, and `BAILIAN_MODEL=qwen3.8-flash` in the untracked `.env`. `configure.ps1` replaces the example Gateway token with a random value, installs the official OpenClaw SearXNG plugin if missing, migrates Hermes configuration, selects search/extraction providers, disables OpenClaw's unneeded heartbeat, and syncs this repository's skills into both named volumes. The tested image digests are pinned in `.env.example`; update them deliberately after checking upstream releases. Do not put keys in Git, chat, issues, or screenshots. Agent state uses named Docker volumes to avoid SQLite and permissions problems on Docker Desktop's Windows bind mounts.

Run `docker compose logs --tail=200 openclaw` or `docker compose logs --tail=200 hermes` to inspect startup. Do not mount Docker's socket, DraftDesk's SQLite directory, or a host-wide home directory. Agent results should enter DraftDesk through its scoped intake protocol, after validation, rather than writing the database directly.

After credentials are available, validate in order: plain completion, structured output, tool-call continuation, fixed evidence analysis, a small live search, and duplicate-safe DraftDesk intake. Both agents will use the same prompt, source list, time limit, and token budget.

## SearXNG and submission

Start `search/compose.yaml` first so that the external `draftdesk-search` network exists. The configuration script handles the following settings; these manual commands are useful when debugging. Hermes uses SearXNG for discovery and Exa's keyless extraction endpoint for public article text. That endpoint is rate-limited and may fail on JavaScript-heavy, login-only, or blocked pages. OpenClaw uses the official SearXNG provider plugin for search and its bundled `web_fetch` for public page reading:

```powershell
docker compose -f agents/compose.yaml exec openclaw node openclaw.mjs plugins install @openclaw/searxng-plugin
docker compose -f agents/compose.yaml exec openclaw node openclaw.mjs config set tools.web.search.provider searxng
docker compose -f agents/compose.yaml exec openclaw node openclaw.mjs config set plugins.entries.searxng.config.webSearch.baseUrl http://searxng:8080
docker compose -f agents/compose.yaml exec -u 10000:10000 hermes /opt/hermes/.venv/bin/hermes config migrate
docker compose -f agents/compose.yaml exec -u 10000:10000 hermes /opt/hermes/.venv/bin/hermes config set web.search_backend searxng
docker compose -f agents/compose.yaml exec -u 10000:10000 hermes /opt/hermes/.venv/bin/hermes config set web.extract_backend exa
```

Download the current DraftDesk Skill bundle before generating packages. `sourceType` is a fixed enum: official, media, community, product, repository, trend, other. A valid JSON file is not necessarily a valid intake package. Check the actual HTTP receipt; pending-review means received, never verified or published.

For Hermes unattended sessions, keep generated files inside its configured safe write root (`/opt/data` in this image). Do not disable its sandbox to make submission work. A trusted host adapter can submit the file after the agent writes it:

```powershell
# Run from the DraftDesk root. Store a scoped intake token in an ignored local
# JSON file of the form {"token":"..."}; never put the token in this command.
./agents/sync-result.ps1 -Agent hermes -ResultPath /opt/data/research/result.json -CredentialFile ./data/agent-connections/hermes.json
```

The same adapter supports `-Agent openclaw`. Keep the submissionId and content stable when retrying; the receipt will return duplicate=true. The adapter does not schedule jobs or publish content. The existing Python submit helper is an alternative when the agent is already authorized to execute it.

For Docker agents, the simpler and safer path is to save the Agent's final JSON response on the host and submit it with `-ResponseFile` instead of giving the Agent a token or asking it to run a script:

```powershell
./agents/sync-result.ps1 -Agent openclaw -ResponseFile ./data/agent-connections/openclaw-response.json -CredentialFile ./data/agent-connections/openclaw.json
./agents/sync-result.ps1 -Agent hermes -ResponseFile ./data/agent-connections/hermes-response.txt -CredentialFile ./data/agent-connections/hermes.json
```

The adapter accepts OpenClaw's CLI JSON envelope, a raw intake JSON object, or one JSON code block in Hermes' final answer. It rejects an unsuccessful Agent run, checks the intake protocol before storing, and removes a date-only `publishedAt` rather than inventing a timestamp. Keep response and credential files under ignored local `data/`; never commit or paste their contents. Use a fresh OpenClaw `--session-id` per run; a Gateway already running for the same profile rejects `--local`. An extracted excerpt does not imply full-page verification; inaccessible pages remain unverified.

On 2026-09-25, both local agents completed a real Bailian model turn, SearXNG search, official page reading, and a one-evidence JSON submission through the scoped host adapter. The two DraftDesk receipts were `pending-review`; a retry of the same OpenClaw submission returned `duplicate=true`. This confirms the connection and intake path, not recurring unattended research, content quality, or automatic publishing. No separate DraftDesk research schedule was added to either agent; the workbench's own schedules remain separate.

Agent model/search usage is billed by its providers and **is not included in DraftDesk's internal daily token reservation**. A reported cost of zero from a custom model configuration is not a billing guarantee. SearXNG snippets also need source/date checks; a successful search can return old or irrelevant pages.
