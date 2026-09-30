# 外部接入向导与研究说明

外部接入是通用能力：接入指导（配置提示词、Skills 包、JSON Schema、收件协议）对**任何外部 Agent** 都适用，不依赖特定产品——向导里的 OpenClaw / Hermes 选项只是本机实测过的样例。目标用法是让外部 Agent 按工作台导出的策略自主搜罗、整理，并在它自己的调度能力下定时回传收件，作为内置研究与整理管线的替代或补充；工作台不远程控制 Agent、不替用户配置运行器，也不自动创建日程。

> 本文是协议与边界定义；逐步操作（建令牌、curl 示例、各运行器 MCP 配置、排障表）见 **[外部 Agent 接入指南](agent-integration.md)**。

## 读取 API 与 MCP（外部 Agent 消费搜罗数据）

收件是写方向；读取是反方向——让外部 Agent 把工作台已搜罗的热榜、证据与选题产物当作素材库，先读后补，避免重复搜罗。

- **令牌**：在「外部接入 → 接入令牌」创建连接时按需勾选「只读访问」与「消费标记」，得到对应 scope 的令牌（旧令牌默认仅提交）。请求头 `Authorization: Bearer <令牌>`；scope 双向隔离：只读令牌调回传/消费返回 403，提交令牌调读取/消费同样 403。
- **REST**（全部 GET、游标分页、`nextCursor` 翻页）：
  - `GET /api/v1/agent/hotspots?q=&source=&days=&limit=&cursor=` —— 近 N 天原始热榜候选（含被策略筛除的，`status`/`reason` 标注去向）
  - `GET /api/v1/agent/evidence?q=&sourceType=&days=&limit=&cursor=` —— 证据库检索，摘要 ≤2000 字符并带 `provenance`
  - `GET /api/v1/agent/artifacts?kind=&quality=&days=&limit=&cursor=` —— 产物列表，**全部质量分层带标签**（ready 通过检查 / review 待验证 / rejected 已否决）
  - `GET /api/v1/agent/artifacts/{id}` —— 产物详情，含分析字段与引用证据摘要内联
  - `GET /api/v1/agent/stats` —— 库存概览（各类型/质量/创作状态数量、热榜已消费/未消费、最近任务）
- **消费标记**（consume scope，REST 专用、不进 MCP 工具面）：
  - `POST /api/v1/agent/consume` —— 批量把已处理的热榜/证据置为已消费。`ids` 与 `filter`（days/status/sourceId）二选一，单批 ≤1000 超出返回 `nextCursor`；`reason` 四选一（no-ai-signal / outdated / off-domain / processed-into-artifact）；**`dryRun` 默认 true**，先拿影响面确认再显式传 false 落库。消费 ≠ 删除：只加状态层，30 天内可撤销。
  - `GET /api/v1/agent/consume/status?target=hotspots|evidence` —— total/consumed/remaining 与按原因分布；工作台首页热榜计数读 `remaining`。
  - `POST /api/v1/agent/unconsume` —— 30 天撤销窗口内复活；过期返回 410。
- **MCP**：`POST /api/v1/mcp`（JSON-RPC over Streamable HTTP 的纯 POST 简化档，无 SSE；与 REST 同一令牌鉴权）。工具：`search_hotspots` / `search_evidence` / `list_artifacts` / `get_artifact` / `get_workspace_stats`。支持远程 MCP 的运行器（OpenClaw 等）直接配端点 URL + 令牌即可，无需安装。
- **stdio 桥**（只支持本地 stdio MCP 的运行器）：`node scripts/mcp-bridge.mjs`，环境变量 `DRAFTDESK_URL` + `DRAFTDESK_READ_TOKEN`，工具清单与 HTTP MCP 一致。
- **边界**：只读，不触发模型调用、不消耗预算；永不返回密钥、模型配置、讨论会话与外部原始提交包；证据只给摘要不给全文；每个响应带 `notice`——热榜标题与摘录仅为线索，引用前核对原链接。「是否公开」仍只由发布流程决定，此 API 不改变产物可见性。

## 使用

1. 在外部接入选择研究策略，再选择 OpenClaw / Hermes / 其他 Agent、宿主机 / Docker Desktop / 远程位置，以及采集或完整研究模式。
2. 把生成的配置提示词交给自己的 Agent；由它检查当前环境、安装或加载 Skill、配置搜索和提交方式。工作台提供 Skills、Schema 和协议，不修改用户的 Agent 配置。提示词包含策略、来源、预算、预检步骤和交付要求，不包含令牌。
3. 用户自行在 Agent 的安全环境设置提交令牌。让 Agent 用 preflight.py 或等价 HTTP 请求验证连接权限；一次真实搜索取得最多两条证据，再预检标准包。两种预检都不入库，不调用工作台模型。
4. 查看实际查询和来源，按授权正式运行。完整研究可以提交 drafts，工作台不会自动再次生成或公开。
5. 收件箱显示已接收、已创建任务、分析中、完成/失败/取消及关联结果。相同回执、相同策略重复点击不创建新任务；失败后可以明确重试。使用其他策略需要用户再次选择并发起分析。

远程地址必须是无凭据、无查询和路径的 HTTPS 入口。向导不自动安装搜索服务或开放公网。生成的来源约束和预算需要外部运行器执行，不能当作工作台对外部费用的强制控制。

同机 Docker 的另一种交付方式是让 Agent 只返回严格 JSON 证据包，由用户在宿主机用提交令牌直接调用 `POST /api/v1/intake` 做协议预检和提交（重复提交按 submissionId 幂等，不重复写入）。这样提交令牌无需放进 Agent 容器或对话；这是推荐做法，不是用户必须采用的接入方式。外部 Agent 每次研究建议指定新的 session ID，避免旧会话历史带来高额 token 消耗。

本机 2026-09-24 试跑（当时通过本地适配器提交，该适配器随 agents 栈退役移除，现以 `POST /api/v1/intake` 等价完成）：两个容器均能访问 SearXNG 与工作台，令牌预检通过；Hermes 一次搜索返回 10 条线索，筛出 1 条官方来源，提交得到 `pending-review` 回执；OpenClaw 首个过宽任务超时，改为新会话、限定一次搜索后取得同一官方来源，日期精度不符被预检拒绝，移除仅日期的 `publishedAt` 后提交成功。两包均仅含证据，无草稿。当时 Hermes 仅配置了 SearXNG 搜索，未配置正文提取。摘要材料不得冒充全文或直接支撑高质量选题。外部模型费用不受 DraftDesk 内置预算约束。

2026-09-25 已补齐两边配置：Hermes 使用 SearXNG 搜索与 Exa 免密钥公开网页提取，OpenClaw 使用官方 SearXNG 插件与内置 `web_fetch`；两边通过真实模型调用、搜索、页面读取、结构化 JSON 与独立收件令牌提交，各得到 1 条证据的 `pending-review` 回执。重建容器后设置与技能仍存在。Exa 免密钥端点有速率与网页可访问性限制，需看实际提取结果；登录页、反爬或动态渲染页面不能由这条链路保证采到正文。Agent 自身未新增周期任务，工作台的内置日程与外部 Agent 的模型费用仍需分别管理。

创作活动列表默认展示当前可参与的通过检查与待验证记录，并清楚标注质量状态；只有通过检查的记录属于推荐。登录可见的官方规则可以作为个人研究的原始材料，但必须从可信创作者中心页面取得、包含明确起止日期与年份、参与条件和原文锚点；无法核对的线索保留在“待验证”，过期活动只在历史筛选中出现。规则页的截图和文字不会自动证明该用户已满足资格。

## 研究说明

研究策略页提供运行前查询意图、来源启用情况、范围与预算预览；运行记录和已关联的收件显示来源问题、补证状态、排除理由和无推荐原因。相关内容可下载为中间分析 JSON。
“每日发现 → 采集覆盖”可先选择策略执行一次只采集预览：最多读取 3 个已启用的非网页搜索来源，保留至多 12 条证据与来源成功/失败计数，不调用模型、不形成推荐。预览证据会进入本机证据历史；它不代表一次完整研究，也不消耗 DraftDesk 模型 token。正式研究仍需单独手动启动或启用策略日程。
开启日程时若当天设定时间已经过去，首次执行从下一天该时段开始，避免保存配置后立刻补跑一轮付费研究；Worker 在北京时间计算日期与时间，失败不会自动重复付费调用。

## 接口

- POST /api/v1/intake-check：使用仅提交令牌；{"probe":true} 检查权限，标准证据包进行结构和引用预检，不入库。
- POST /api/v1/validate-intake：本地工作台手动预检，无需创建令牌。
- POST /api/v1/jobs：可带 receiptId，服务端使用该回执的证据；相同回执/策略幂等，retry=true 只对失败或取消任务创建新任务。
- 令牌不能读取工作区、讨论、历史、配置或发起分析。预检权限只新增无状态检查。

## 2026-09-24 实机验证

- 工作台全套 92 项测试通过；生产 Docker 构建、网页主要导航、收件箱、采集覆盖视图和定时启用保护已检查。
- OpenClaw 与 Hermes 均通过真实容器网络访问 SearXNG 和工作台；两者各执行了至少一次真实搜索，并分别用受信宿主机适配器提交 1 条官方来源证据，获得 `pending-review` 回执。两份样本均无草稿，也没有被工作台自动分析或公开。
- OpenClaw 复用主会话使首次任务超时，改为新会话与一次搜索后完成；Hermes 单次命令拦截脚本写入，改为输出 JSON 给宿主机。日期只有年月日时省略 `publishedAt`，不伪造时分秒。SearXNG 在此配置下只负责搜索，不提供正文提取。
- 已启用本机资讯、热词和应用三个每日策略，分别于北京时间 01:00、01:15、01:30 开始；当晚启用不会回补当日已经错过的时段。三项最大预留合计 395000 token，低于当前每日 600000 上限。第一次真实自动产出及长期稳定性仍待后续运行观察。
