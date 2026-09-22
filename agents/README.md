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

OpenClaw is at `http://127.0.0.1:18789/`. Hermes exposes its gateway at `http://127.0.0.1:8642/` and dashboard at `http://127.0.0.1:9119/`. All ports are loopback-only.

Set the Bailian key and the exact OpenAI-compatible base URL from your Bailian account in the untracked `.env`. Do not put keys in Git, chat, issues, or screenshots. The model name must be the value available to your account; a branded name is not considered verified until a request succeeds.

Run `docker compose logs --tail=200 openclaw` or `docker compose logs --tail=200 hermes` to inspect startup. Do not mount Docker's socket, DraftDesk's SQLite directory, or a host-wide home directory. Agent results should enter DraftDesk through its scoped intake protocol, after validation, rather than writing the database directly.

After credentials are available, validate in order: plain completion, structured output, tool-call continuation, fixed evidence analysis, a small live search, and duplicate-safe DraftDesk intake. Both agents will use the same prompt, source list, time limit, and token budget.
