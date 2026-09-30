# 外部 Agent 接入指南

手把手把自己的 Agent（OpenClaw、Hermes 或任何能执行提示词、调用 HTTP 的运行器）接到拾题工作台。两条链路各取所需：

- **读取**——把工作台已搜罗的热榜、证据、选题产物当作素材库，先读后搜，避免重复劳动
- **回传**——把 Agent 自己搜罗整理的成果按协议送回工作台（先待审）

协议与安全边界的完整定义见 [接入说明](external-onboarding.md)；本文是操作手册。

## 0. 前置检查

工作台已启动，且你的 Agent 能访问它的地址：

```sh
curl http://127.0.0.1:5173/api/v1/health     # {"ok":true,...}
```

| Agent 运行位置 | 用哪个地址 |
| --- | --- |
| 与工作台同一台电脑（宿主机） | `http://127.0.0.1:5173` |
| 同机 Docker 容器里 | `http://host.docker.internal:5173`（容器里的 localhost 不是宿主机） |
| 另一台机器 | 你自建的 HTTPS 安全入口（无凭据、无路径） |

## 1. 创建接入令牌（一次）

1. 打开工作台「外部接入 → 接入令牌」
2. 填连接名称，**勾选「同时允许只读访问（agent API / MCP 读取搜罗数据）」**——不勾则令牌只能回传
3. 创建后立即复制令牌（`dd_` 开头，**仅显示一次**，服务端只存散列）
4. 令牌放进 Agent 侧的环境变量，不要写进提示词、日志或仓库

权限是双向隔离的：只读令牌调回传接口返回 403，仅回传令牌调读取接口同样 403；可随时在页面单独撤销。

## 2. 读取链路

### 2.1 REST（任何能发 HTTP 的工具都能用）

全部 `GET`，请求头 `Authorization: Bearer <令牌>`，`nextCursor` 透传翻页：

```sh
TOKEN=dd_你的令牌
BASE=http://127.0.0.1:5173

# 库存概览：各类型/质量产物数量、证据总量、最近任务
curl -H "Authorization: Bearer $TOKEN" "$BASE/api/v1/agent/stats"

# 热榜：近 14 天原始候选（含被策略筛除的，status/reason 标注去向）
curl -H "Authorization: Bearer $TOKEN" "$BASE/api/v1/agent/hotspots?q=AI&limit=20"

# 证据库检索（标题+摘要文本匹配；sourceType 可选 trend/community/official/repository/product/other）
curl -H "Authorization: Bearer $TOKEN" "$BASE/api/v1/agent/evidence?q=会议&sourceType=community"

# 选题产物：kind 可选 news/topic/trend/idea/activity；quality 可选 ready/review/rejected
curl -H "Authorization: Bearer $TOKEN" "$BASE/api/v1/agent/artifacts?kind=topic&quality=review"

# 单条详情（含分析字段与引用证据摘要内联）
curl -H "Authorization: Bearer $TOKEN" "$BASE/api/v1/agent/artifacts/<id>"
```

### 2.2 MCP 端点（支持远程 MCP 的运行器，如 OpenClaw）

端点 `POST /api/v1/mcp`（JSON-RPC 2.0，纯 POST 响应，无 SSE），鉴权同一 Bearer 令牌。在你的运行器 MCP 配置里填端点 URL + 令牌即可，无需安装任何东西。手工验证三步：

```sh
# ① 握手
curl -s -X POST "$BASE/api/v1/mcp" -H "Authorization: Bearer $TOKEN" \
  -H "content-type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18"}}'

# ② 工具列表
curl -s -X POST "$BASE/api/v1/mcp" -H "Authorization: Bearer $TOKEN" \
  -H "content-type: application/json" \
  -d '{"jsonrpc":"2.0","id":2,"method":"tools/list"}'

# ③ 调一个工具
curl -s -X POST "$BASE/api/v1/mcp" -H "Authorization: Bearer $TOKEN" \
  -H "content-type: application/json" \
  -d '{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"get_workspace_stats","arguments":{}}}'
```

五个工具：`search_hotspots`（热榜）、`search_evidence`（证据）、`list_artifacts`（产物，带质量标签）、`get_artifact`（产物详情）、`get_workspace_stats`（库存概览）。参数与同名 REST 查询参数一致。

### 2.3 stdio 桥（只支持本地 stdio MCP 的运行器）

仓库自带零依赖桥脚本，Agent 侧以 stdio MCP server 启动，内部转发到 REST：

```sh
DRAFTDESK_URL=http://127.0.0.1:5173 \
DRAFTDESK_READ_TOKEN=dd_你的令牌 \
node scripts/mcp-bridge.mjs
```

运行器配置里给命令行 `node scripts/mcp-bridge.mjs` + 上述两个环境变量即可；工具清单与 HTTP MCP 完全一致。

## 3. 回传链路（把搜罗成果送回来）

1. 下载 Skill 包与协议：工作台「外部接入」页 → 下载 Skills 与提交脚本 / JSON Schema（或 `GET /api/v1/skill-bundle`、`GET /api/v1/schema`）
2. Agent 环境变量：`DRAFTDESK_URL`、`DRAFTDESK_TOKEN`（同一令牌，勾读过即双向可用）
3. 先预检再提交：

```sh
python skills/draftdesk-submit/scripts/preflight.py     # 连接与权限检查
python skills/draftdesk-submit/scripts/submit.py research.json
```

同一批次稳定使用同一 `submissionId`：重复提交不重复写入，同 ID 不同内容返回 409。外部提交默认待审且私有，不会触发工作台的付费分析。

## 4. 消费标记（把处理完的条目置为已消费）

处理完一批素材后，用 consume scope 令牌把它们标记为已消费——工作台首页热榜计数只反映未消费部分，数字不再只增不减。

```sh
# ① 看还剩多少未消费
curl -H "Authorization: Bearer $TOKEN" "$BASE/api/v1/agent/consume/status?target=hotspots"

# ② 先跑 dryRun（默认 true）拿影响面，确认后再落库
curl -s -X POST "$BASE/api/v1/agent/consume" -H "Authorization: Bearer $TOKEN" \
  -H "content-type: application/json" \
  -d '{"target":"hotspots","filter":{"days":30,"status":"watch","sourceId":"weibo-hotsearch"},"reason":"no-ai-signal","dryRun":true}'

# ③ 确认无误后正式消费（dryRun:false）；ids 与 filter 二选一，单批 ≤1000
curl -s -X POST "$BASE/api/v1/agent/consume" -H "Authorization: Bearer $TOKEN" \
  -H "content-type: application/json" \
  -d '{"target":"hotspots","ids":["https://a.example.org/1"],"reason":"processed-into-artifact","producedRef":"大纲文件或产物ID","dryRun":false}'

# ④ 标错了？30 天内撤销
curl -s -X POST "$BASE/api/v1/agent/unconsume" -H "Authorization: Bearer $TOKEN" \
  -H "content-type: application/json" \
  -d '{"target":"hotspots","ids":["https://a.example.org/1"]}'
```

janitor 自动回收：worker 每日把观测超过 7 天的热榜、采集超过 30 天且无产物引用的证据自动置为已消费（reason=outdated）——即使 Agent 一周不跑，remaining 也不会失控增长；被产物引用的证据永不自动回收。

`reason` 四选一：`no-ai-signal`（无 AI 信号）/ `outdated`（过期）/ `off-domain`（非目标领域）/ `processed-into-artifact`（已写成草稿或大纲，建议附 `producedRef`）。消费不删除原始记录，只改变可见性与计数；重复消费幂等返回 `alreadyConsumed`。

## 5. 消费建议（给 Agent 的工作流）

1. `get_workspace_stats` 看库存——重点是 `byQuality.review`（待验证积压）与 `hotspots.remaining`（未消费热榜）
2. `list_artifacts?quality=review` 挑与自己任务相关的条目，`get_artifact` 读详情与证据缺口
3. 对缺口补证（自己的搜索工具），核对原链接与日期
4. 整理成标准证据包**回传**（第 3 节）——重复工作台已有的材料没有价值

数据口径红线（每个响应的 `notice` 字段同款）：热榜标题与摘录仅为线索，不构成事实认证；`quality=review` 是待验证、`rejected` 是已否决；即时热度不是增长率；证据摘要不等于全文。产物「是否公开」只由工作台发布流程决定，读取 API 不改变可见性。

## 6. 故障排查

| 现象 | 原因与处理 |
| --- | --- |
| 401 | 令牌缺失/拼错/已撤销——重新创建；旧令牌先确认未撤销 |
| 403 `令牌无 read 权限` | 令牌创建时没勾「只读访问」——建新令牌 |
| 403 `令牌无 submit 权限` | 只读令牌调了回传接口——回传用带 submit 的令牌 |
| 403 `令牌无 consume 权限` | 令牌创建时没勾「消费标记」——建新令牌 |
| 410 | unconsume 超过 30 天撤销窗口，条目已软化处理（仍可读，不再计入未消费） |
| 404 | 路径或产物 ID 不对；产物可能已归档 |
| JSON-RPC `方法不存在` | MCP 端点只支持 initialize/tools/list/tools/call，其余方法按协议报 -32601 |
| 容器里连不上 | 用 `host.docker.internal`，不是 localhost |
| 跨机器连不上 | 工作台默认只绑本机 127.0.0.1；远程需自建 HTTPS 入口，不要直接裸暴露端口 |
