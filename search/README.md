# DraftDesk SearXNG

This is the local, self-hosted web-search provider for DraftDesk, OpenClaw and Hermes.
It is intentionally bound to `127.0.0.1:8080` and joined to the shared Docker network
`draftdesk-search`. It does not contain model keys or DraftDesk intake tokens.

## Start

```powershell
docker network create draftdesk-search
cd C:\Users\77958\Projects\draftdesk\search
docker compose up -d
docker compose ps
curl "http://127.0.0.1:8080/search?q=AI+工作流&format=json"
```

The container name is `searxng`; other containers on the shared network use
`http://searxng:8080`.

SearXNG is a separate AGPL-3.0 service. Keep its source and license notices when
redistributing or offering a network service based on it.
