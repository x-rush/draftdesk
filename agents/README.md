# DraftDesk external agents

This optional Compose project runs OpenClaw and Hermes separately from DraftDesk. From PowerShell:

```powershell
cd C:\Users\77958\Projects\draftdesk\agents
Copy-Item .env.example .env
notepad .env
docker compose pull
docker compose up -d
docker compose ps
```

OpenClaw is at `http://127.0.0.1:18789/`. Hermes exposes its gateway at `http://127.0.0.1:8642/`. The optional Hermes dashboard is disabled by default. To use `http://127.0.0.1:9119/`, configure a dashboard auth provider before setting `HERMES_DASHBOARD=1`; a dashboard without authentication will refuse to start and repeatedly restart. All published ports are loopback-only.

Set the Bailian key, the exact OpenAI-compatible base URL, and `BAILIAN_MODEL=qwen3.8-flash` in the untracked `.env`. Do not put keys in Git, chat, issues, or screenshots. Agent state uses named Docker volumes to avoid SQLite and permissions problems on Docker Desktop's Windows bind mounts.

Run `docker compose logs --tail=200 openclaw` or `docker compose logs --tail=200 hermes` to inspect startup. Do not mount Docker's socket, DraftDesk's SQLite directory, or a host-wide home directory. Agent results should enter DraftDesk through its scoped intake protocol, after validation, rather than writing the database directly.

After credentials are available, validate in order: plain completion, structured output, tool-call continuation, fixed evidence analysis, a small live search, and duplicate-safe DraftDesk intake. Both agents will use the same prompt, source list, time limit, and token budget.

## SearXNG and submission

Start `../search/compose.yaml` first so that the external `draftdesk-search` network exists. Hermes discovers its native SearXNG provider from `SEARXNG_URL`. OpenClaw also requires its official provider plugin (the URL environment variable alone does not install it):

```powershell
docker compose exec openclaw node openclaw.mjs plugins install @openclaw/searxng-plugin
docker compose exec openclaw node openclaw.mjs config set tools.web.search.provider searxng
docker compose exec openclaw node openclaw.mjs config set plugins.entries.searxng.config.webSearch.baseUrl http://searxng:8080
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

The adapter accepts OpenClaw's CLI JSON envelope, a raw intake JSON object, or one JSON code block in Hermes' final answer. It rejects an unsuccessful Agent run, checks the intake protocol before storing, and removes a date-only `publishedAt` rather than inventing a timestamp. Keep response and credential files under ignored local `data/`; never commit or paste their contents. Use a fresh OpenClaw `--session-id` per run; a Gateway already running for the same profile rejects `--local`. Hermes with SearXNG can search but its `web_extract` needs a separate extraction provider; until configured, mark search snippets as excerpts and do not claim full-page verification.

Agent model/search usage is billed by its providers and **is not included in DraftDesk's internal daily token reservation**. A reported cost of zero from a custom model configuration is not a billing guarantee. SearXNG snippets also need source/date checks; a successful search can return old or irrelevant pages.
