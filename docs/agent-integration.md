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
| 读簇/大纲 | read | GET /agent/clusters、outlines（支持 `limit`≤100 与 `cursor` 偏移分页，响应带 `nextCursor`/`total`） |
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


## 热词链路回传（seen-terms）

除证据包外，Agent 还可以把每天看到的热词/新词回传到热词雷达，与内置提取共用一个词库：

```sh
curl -X PUT "$DRAFTDESK_URL/api/v1/agent/seen-terms"   -H "Authorization: Bearer $DRAFTDESK_TOKEN"   -H "content-type: application/json"   -d '{"items":[{"term":"claude skills","sources":["reddit"],"observations":3,"relevance":"strong","region":"global"}]}'
```

字段语义（全部可选除 term）：

- `relevance`：`strong | weak | off` 三档。strong=AI 全谱系 top 级需求（工具/模型发布、AI 名人动态、AI 政策版权、AI 短剧、独立开发自动化）；weak=沾边非主航道；off=圈外（自动驾驶、点击器类灰产、影视明星）。**只有 strong 词会回流挖掘种子**，off 同时置 offTopic。
- `region`：`global | cn`。海外词=英文内容选题+站群候选；中文词=纯内容创作线。不传时按 sources 自动推断（百度/B站/微博/掘金/知乎等→cn，其余→global）。
- `observations`：观测次数（整数）；重复回传取 max，不叠加。
- `seed`：首见血缘标记；`status`：new/rising/sustained（只升不降）。

判定由工作台内置 AI 兜底：未判定词会在每日整理时按 persona 标尺回填三档（只写档位，不虚增观测）。词表与统计在「热词趋势」页；同题重复回传按 termId 归一（trim+小写+去内部空格）。

## ⑧ 大纲提交（选题体系 · 第六轮批 B）

外部 Agent（external 模式）是「approved → 第一版大纲」的主执行者。builtin 兜底仅在没有外部 Agent 时启用（aiPolicy.draft 联动），两者不双跑。

### 双标注口径（平台 × 题材）

- `platform` 五值枚举：`gzh`（公众号）/ `tiebuhao`（贴图号）/ `xhs-note`（小红书笔记）/ `xhs-video`（小红书视频笔记）/ `threads`。旧值（公众号/小红书/Threads）与中文标签提交时自动归一。
- `category` 六值枚举：`newtech`（AI 新技术）/ `news`（新资讯）/ `oss`（开源工具）/ `selfproduct`（自研产品）/ `thinking`（个人思考）/ `hot`（社会热点）。

### 提交大纲

```bash
# upsert（带 id 更新，不带新建）；clusterId 必须是已存在的簇（clu-inbox 收集箱可用）
curl -X PUT "$BASE/api/v1/agent/outlines" \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{
    "id": "out-optional-for-update",
    "clusterId": "clu-inbox",
    "platform": "gzh",
    "category": "newtech",
    "contentType": "长文",
    "title": "选题标题",
    "outline": ["第一部分", "第二部分", "第三部分"],
    "keyPoints": ["要点一", "要点二"],
    "evidenceRefs": ["https://…"],
    "draftBody": "完整的 Markdown 初稿（approved 选题的第一版大纲写在这里）"
  }'
```

- approved 选题写完 `draftBody` 后，把决策推进到 drafting：`PUT /api/v1/outlines/:id/decision`（无令牌 UI 口）或集群工具同义口。
- **提示词矩阵**（平台模板 × 题材角度，与内置 AI 共用的单一来源）随 Skill 包分发：`skills/prompts/outline-matrix.md`——按「平台模板节 + 题材角度节 + 选题素材」组合，不硬编码 24 组合。
- **按平台拍板**：`PUT /api/v1/outlines/:id/platform-decision`，body `{"platform":"gzh","decision":"approved"}`——写 `perPlatformDecision[platform]` 并同步同题同平台的行；同题 ×N 聚合组内各平台分别拍，互不连拍。聚合 `decision` 取最前进正向状态（published > drafting > approved > rejected > deferred > pending）。
