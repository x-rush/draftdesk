# 外部 Agent 接入指南

任何能执行提示词、调用 HTTP 的外部 Agent（OpenClaw、Hermes、或自建脚本）都可接入拾题工作台。

两条链路各取所需：
- **读取**——把工作台已搜罗的热榜、证据、选题产物当作素材库，先读后搜，避免重复劳动
- **回传**——把 Agent 自己搜罗整理的成果按协议送回工作台（先待审）

拍板（decision）只能由人在审查台完成，Agent 不能改。

---

## ① 五分钟接入

### 1.1 前置检查

```sh
curl http://127.0.0.1:5173/api/v1/health     # {"ok":true,...}
```

### 1.2 建连接令牌（一次）

打开工作台「外部接入 → 接入令牌」页：

| 勾选项 | scope | 能力 |
|---|---|---|
| ☐ 只读访问 | read | 读热榜/证据/选题产物 |
| ☐ 消费标记 | consume | 批量消费标记 + 撤销 |
| ☐ 建议写回 | suggest | 写回 clusters / outlines / suggestions / draft |
| 提交回传 | submit | **默认包含**，无需勾选——回传证据包的基础能力 |

创建后立即复制令牌（`dd_` 开头，**仅显示一次**，服务端只存散列）。

### 1.3 四条自验命令

```sh
TOKEN=dd_你的令牌
BASE=http://127.0.0.1:5173

# ① 读人设（expect 200；401 = 令牌错，403 = 没 read scope）
curl -s -w "\n%{http_code}" -H "Authorization: Bearer $TOKEN" "$BASE/api/v1/agent/persona"

# ② PUT clusters 空 body（expect 400 校验错——400 才算权限通过，403 是没 suggest scope）
curl -s -w "\n%{http_code}" -X PUT "$BASE/api/v1/agent/clusters" \
  -H "Authorization: Bearer $TOKEN" -H "content-type: application/json" -d '{}'

# ③ 读消费状态（expect 200）
curl -s -H "Authorization: Bearer $TOKEN" "$BASE/api/v1/agent/consume/status?target=hotspots"

# ④ POST consume dryRun（expect 200 + toConsume/notFound）
curl -s -X POST "$BASE/api/v1/agent/consume" \
  -H "Authorization: Bearer $TOKEN" -H "content-type: application/json" \
  -d '{"target":"hotspots","reason":"no-ai-signal","dryRun":true}'
```

①③④ 返回 200 即通过；② 返回 400 是**权限通过但参数不全**——也算通过（因为你只发 `{}`）。

### 1.4 写 mcp.json（支持远程 MCP 的运行器）

```json
{
  "mcpServers": {
    "draftdesk": {
      "type": "http",
      "url": "http://127.0.0.1:5173/api/v1/mcp",
      "headers": {
        "Authorization": "Bearer dd_你的令牌"
      }
    }
  }
}
```

五个工具：`search_hotspots`（热榜）、`search_evidence`（证据）、`list_artifacts`（产物，带质量标签）、`get_artifact`（产物详情）、`get_workspace_stats`（库存概览）。参数与同名 REST 查询参数一致。

---

## ② 能写什么不能写什么

| 能力 | scope | 说明 |
|---|---|---|
| 读热榜/证据/产物 | read | GET /agent/hotspots、evidence、artifacts、stats |
| 消费标记 | consume | POST /agent/consume、/agent/unconsume |
| 建簇 | suggest | PUT /agent/clusters |
| 写大纲 | suggest | PUT /agent/outlines |
| 写建议 | read | POST /agent/suggestions |
| 写草稿正文 | suggest | PUT /agent/decisions/:id/draft |
| **拍板 decision** | ❌ 永不可写 | 只能由人在审查台完成，接口层无此路由 |
| 删数据 | ❌ 不可删除 | 消费只改可见性，unconsume 可撤销 |

`decision` 字段不在任何 agent 写入面的 zod schema 里——塞进去会被 `.strict()` 校验拒绝返回 400 Unrecognized key。

---

## ③ 身份键口径

簇成员（memberIds）与大纲的 evidenceRefs 一律用**热点 url 原文**。
服务端在消费时会自动做 urlKey 归一化（去 hash、去 utm_/fbclid/gclid 追踪参数），
所以传原始 url 或归一化 url 均可匹配。不要自己拼归一化，也不要填 ev-xxx。

---

## ④ 建议多源、拍板唯一

多个 Agent 可同时写 suggestions 与 clusters，按 producedBy 区分（builtin-ai / agent:名称 / human），互不覆盖。拍板（decision）只能由人在审查台完成，Agent 不能改。

---

## ⑤ 开关语义

participants 配置（config 集合 participants 字段）按来源控制读写：

| 字段 | 效果 |
|---|---|
| enabled=false | 该来源的写回请求直接 403「来源已停用」（服务端强制） |
| canWrite=false | 只能读，不能写 clusters/outlines/suggestions |
| canRead=false | 完全禁用（包括读） |

未登记的来源默认放行（向后兼容）。

---

## ⑥ 消费语义

消费**只改可见性与计数，不删除原始记录**。
已消费的条目仍可查询，只是不再计入 remaining。
30 天内可用 `POST /agent/unconsume` 撤销，超时返回 410 Gone。

`clusterIds` 消费整簇、`exceptIds` 排除部分条目、`ids` 单条精准消费——
三选一，`dryRun` 默认 true 先拿影响面再落库。

---

## ⑦ 错误码对照表

| HTTP | code | 触发场景 |
|---|---|---|
| 400 | INVALID_PAYLOAD | 参数格式错、字段缺失、zod 校验失败 |
| 400 | TARGET_MISMATCH | 簇 target 与请求 target 不一致 |
| 400 | BATCH_TOO_LARGE | 簇展开后 >5000 条 |
| 401 | UNAUTHENTICATED | 令牌缺失/拼错/已撤销 |
| 403 | SCOPE_MISMATCH | 令牌无所需 scope |
| 403 | PERMISSION_DENIED | 来源只读（canWrite=false）|
| 403 | SOURCE_DISABLED | 来源被停用（enabled=false）|
| 404 | NOT_FOUND | 路径或产物 ID 不存在 |
| 409 | CONFLICT | 同 ID 不同内容（回传幂等冲突）|
| 410 | GONE | unconsume 超过 30 天撤销窗口 |
