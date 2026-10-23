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

**意图三分类与站群门槛（第七轮批 1，规则同源）**：

- `demandIntent`：`tool | info | nav` 三分类（tool=工具/产品需求语义，如 generator/converter/calculator 词根族）。内置 AI 判 strong 时自动产出；外部 Agent 复核 PUT `/agent/seen-terms` 时也可带同名字段。标尺读 `persona.intentPolicy`（`GET /agent/persona` 即含），与内置判定同源。
- `GET /agent/siteGate`：站群门槛规则（`requireStrong/serpDedicatedMax/monthlySearchMin/kdMax/cpcMin`）。外部 Agent 的站群标注逻辑必须读它而不是硬编码白名单——改 `config.siteGate` 数值双端行为跟随。内置判定 tick 会自动给达标词标 `siteCandidate=true`（`siteCandidateBy=builtin-gate-v1`），Agent 复核只需处理价值分与域名清单；已标注词内置 sweep 不覆写。
- 哥飞三指标（第七轮批2）：`PUT /agent/seo-terms` 已放行 `monthlySearch/kd/cpc/gepheiFetchedAt` 四字段；`gepheiFetchedAt` 超 90 天视为过期，读方（siteGate 全门槛判定、价值分 月搜×CPC÷KD）自动回退降级。
- **哥飞分工（第七轮批4 v3.1 手动优先，覆盖旧口径）**：外部 Agent **直连哥飞永久移除**——哥飞 API 调用唯一出口=工作台内置 tick（token 在 settings，用户自填）。外部 Agent 为**只读消费方**：读词库指标/机会卡/标杆站页面（GET /agent/benchmark-pages）/外链来源站（GET /agent/link-prospects）做分析与意图交叉验证（哥飞权威 vs 内置标注，冲突标 intent-conflict 留人工）。付费接口自动调用由用户在 settings 授权勾选（autoMetrics/autoCollect，默认关=纯手动模式）；手动数据经「站点发现页手动回传框」或 POST /api/v1/seo-terms/manual 落库（✋manual-gephei 权重最高）。判定方法论共用 skills/seo-methodology/SKILL.md（工作台内置，与内置判定同源）。
- **哥飞余额语义（实测）**：`GET /api/v1/me` 返回 `apiAvailable`（开放 API 可用，工作台自动调用只扣这部分）/`wallet.daySpent/dayCap`（日上限）/`gift`（每日赠送 500，仅限网站内使用，API 不扣）。响应归一已按真实合同校准（2026-10-14 实测：data.keywords 为 map；volume 值含 avg/avgCpc；difficulty 值为纯数字）。

## 机会引擎口径（R10.11-2 老大拍板 B，2026-10-18 定稿）

**全引擎自动出卡，external 模式照跑**——「应用机会就是都要从所有采集数据里找，热词趋势也是应用机会来源」（老大原话）。七生成器（抱怨/新产品/官方动态/热词/站群候选/组级 appGap/新站复刻）每日初筛后自动执行，产出属采集侧衍生，不受消费模式互斥门控。config.autoOpportunityGenerate 可关（默认开；关闭只留组级 from-group 手动转卡）。

## R10 四段流水线（2026-10-17 终版，外部 Agent 必读）

**① 全量采集（01:00 上海，collectAllTick）**：全部 enabled 内容源一次采集落盘（discovery 批次 jobId=`collectall-{日}`，planName=「全量采集」）。当日双闸（非当日 filtered；RSS 24h fallback）+ 超 300 按「当日新>热度」精简 + 跨源 URL 去重。计划的 sourceIds 退化为分析期过滤条件（定时采集已迁移关停）。web 搜索源不在全量采集范围（它是查询执行器，仍由计划/补证路径驱动）。

**② 语义初筛（采集完自动）**：默认全开（config.aiPolicy.triage=cheap；计划可 aiPolicy.enabled=false 退出）。判 none 的组进**归档队列**（`GET /triage/archive` 可查；`POST /triage/restore {jobId,groupId?}` 可恢复）——成员置 filtered（reason 注明归档），不再静默留池。平台角度扩 8 值：+x/facebook/instagram/linkedin（schema/platformAffinity 9 值，xhs-video 视频后置）。

**③ 最后分析与消费（互斥，二选一）**：consumerMode 语义不变——external=外部 Agent（小拾）完成分析与消费，builtin=内置 AI。**每次跑完 ping `POST /agent/consume-report`（consume scope，body `{consumed:N, note?}`）**；审查台今日总览显示回执，超 24h 未跑标黄提醒（运维信号，不触发内置补稿）。机会引擎新增：新站复刻卡（site-launches motive=business/pain 且 HN≥50 或撞词 →「复刻已验证」）、form 扩六值（web-app/site-group/mobile-app/mini-program/tool/open-source，带 monetization 变现口径）。

**④ 审查台（唯一拍板口）**：导航四环节（采集→初筛→消费→审查台）；今日总览卡（采集 N→待拍 N→待查词→外部消费回执）。SkillsView 定位=方法论手册（高级层级）。

## 语义初筛（R9-6：归类 + 注意力判级 + 双线草案）

采集批次入库后，内置 AI 对**规则放行的存活池**做一次语义初筛（分片 cheap 调用 + 片间合并），产出三件事：

1. **归类**：同一事件/主题的跨源候选并为「组」（candidate-groups 集合，`tg-{jobId}` 一批一条）；组 id 幂等，重复触发不重算。
2. **注意力判级**：strong / potential / none + 一句话理由——none（体育/时政/民生噪音）**永不占 selected 名额**；名额按组分配（strong 优先占满 → potential 补位）。
3. **双线草案**：有注意力的组给四平台内容角度（platform ∈ plan.platformAffinity）与 web/app 配套缺口路线（appGap）。

候选条目新增 `attention` 与 `groupId` 字段，判级理由写入 `reason`（`GET /agent/hotspots` 直读可见）。

- **总开关**：`config.aiPolicy.triage`（off/cheap/full，审查台「内置 AI 参与开关」可改；off=回退来源均衡分配，不跑 AI）。计划级 `plan.aiPolicy` 可微调：`enabled`（缺省 trends 类计划开）/`attentionCriteria`（追加判级标准，优先级最高）/`groupGranularity`（coarse=同大事件并组，fine=只有同一事件才并组）。
- **触发**：正常批次在采集时内联跑（初筛，不受 consumerMode 门控）；失败批次标「待语义初筛」由 worker tick 自动补跑（日上限 3 批）。显式补跑：`POST /api/v1/triage/generate`（可带 `{"jobId":"…"}` 定向；**不要带令牌**，本机无鉴权口）。
- **读结果**：`GET /api/v1/triage/groups?jobId=…`（组+成员+判级+草案）；`GET /api/v1/triage/status?jobId=…`（done/failed/pending）。
- **组卡（双线）**：外部 Agent 点 `POST /api/v1/opportunities/generate`（同样不带令牌）时，近 3 天批次的组自动出卡——每角度一张内容线卡（`site:grp:*`，strong→可以试试/potential→待验证）+ 有 appGap 的组一张应用卡（`app:grp:*`）；双卡经 `relatedIds` 互挂。
- **分工边界**：内置 AI 出「组+判级+双线草案」；**外部 Agent（小拾）对组做主分析**（哪些组值得写、写什么角度、app 路线深挖——草案是输入不是替代）+ 质量巡检（抽查归类准确性，归错组超标报用户调 prompt/aiPolicy）；拍板只在审查台。跨日重复组（同一事件分属两天批次）是已知形态，小拾主分析时在拍板建议里注明「与 X 日某组同事件」。

## ⑧ 大纲提交（选题体系 · 第六轮批 B）

外部 Agent（external 模式）是「approved → 第一版大纲」的主执行者。builtin 兜底仅在没有外部 Agent 时启用（aiPolicy.draft 联动），两者不双跑。

### 双标注口径（平台 × 题材）

- `platform` 五值枚举：`gzh`（公众号）/ `tiebuhao`（贴图号）/ `xhs-note`（小红书笔记）/ `xhs-video`（小红书视频笔记）/ `threads`。旧值（公众号/小红书/Threads）与中文标签提交时自动归一。
- `category` 六值枚举：`newtech`（AI 新技术）/ `news`（新资讯）/ `oss`（开源工具）/ `selfproduct`（自研产品）/ `thinking`（个人思考）/ `hot`（社会热点）。
- **资讯类簇强制覆盖贴图号（R8-2①）**：category=news/newtech 的簇，产出大纲时 tiebuhao 版必须覆盖（哪怕其他平台未拍）——图卡形态：3-6 张图卡、首图即观点、每张文案 ≤54 字、视觉风格关键词 3-5 个。内置侧 outlineDraftTick 已自动为同簇缺失 tiebuhao 的资讯行克隆补贴（ensureTiebuhaoClones），外部 Agent 编排时同规则执行。
- **机会引擎整理职责（R9-3，人不整理只拍板）**：opportunities 池的整理/去重/合并/遗弃建议由 AI/外部 Agent 巡检完成——platform 适配产出的多平台卡（同 url 不同 platform 的 site:ev:* 卡）按簇聚合、可标遗弃建议（老大批板后执行）。watch 候选命中多平台时每平台一张卡（dedupeKey 带 platform 后缀），trend-radar.platformAffinity=[gzh,tiebuhao,xhs-note,threads] 四平台。

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

### 向量事件线（R10.23：idx:eventline 组摘要 / idx:termcluster 增量词）

工作台把每日组摘要与增量词嵌入进 Redis（db1，text-embedding-v3 / 1024 维，嵌入调用量记在 meta `vector-embed:<日>`）。外部 Agent 两个集成点：

1. **合并判断前 KNN 查历史同事件**（减少重复出题）：

```bash
curl -X POST "$BASE/api/v1/agent/vectors/search" \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"index":"eventline","text":"AI播放器 本地模型爆火","topK":5}'
# → {"ok":true,"index":"eventline","degraded":false,"hits":[{"title":"...","jobId":"collectall-2026-10-22","attention":"strong","similarity":0.95,"date":1760000000}]}
```

- `index`：`eventline`（组摘要）或 `termcluster`（增量词）；可选 `sinceHours`/`untilHours` 圈时间窗。
- 相似度 = 1 - 余弦距离；≥0.90 视为疑似同事件，命中则挂线复用（不重新出题）。
- `degraded:true` = 向量线不可用（照常处理，不做历史对齐）。

2. **大纲重复抑制（服务端强制，无需 Agent 参与）**：`PUT /agent/outlines` 写入时，工作台自动对新标题与前 48h（不含当日）的组摘要做 KNN——相似度 >0.92 返回 `200 {"duplicate":true,"semantic":true,"score":0.95,"matchedEvent":{...}}` 跳过入库。与 48h 标题精确去重互补；当日向量不参与（当日大纲本就派生自当日组）。
