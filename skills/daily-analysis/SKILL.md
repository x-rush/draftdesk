---
name: daily-analysis
description: 接管 DraftDesk 工作台的每日语义处理：把当日采集候选合并归组、判级写回、归档噪音、为有注意力的组产出选题大纲（一选题一条 + 适合平台 + 推荐建议）与应用机会卡。适用于任何能调 HTTP 的外部 Agent（OpenClaw/Hermes/自建脚本）。
metadata:
  version: "1.1.0"
---

# 每日主分析（DraftDesk 工作台接管流程）

## 你在做什么

工作台每天 01:00 自动采集全部数据源落盘（一个批次，jobId 形如 `collectall-YYYY-MM-DD`）。你的任务是在它之后跑一次**全套语义处理**：通读全部候选 → 语义合并同事件 → 判级 → 写回组结构 → 归档噪音 → 给出选题大纲（一个选题一条，标注适合平台与推荐建议）→ 给应用缺口出机会卡。老大只在审查台拍板，其余全部由你完成。

## 前置：连接工作台

- 工作台地址与令牌：`BASE=http://<工作台IP>:5173/api/v1`，`TOKEN` 为 suggest+read scope 的接入令牌（在工作台「外部接入」页铸造）。所有请求带 `Authorization: Bearer $TOKEN`。
- 日批次号：今天上海日期 `D=YYYY-MM-DD`，批次 `jobId=collectall-$D`。
- 本 skill 无内部依赖、无密钥；只依赖工作台 HTTP API。

## 九步流程

### ① 拉全量候选

```
GET $BASE/agent/triage/candidates?jobId=collectall-$D&status=watch&limit=200&offset=0
```

分页拉完（`total` 大于已拉数就继续翻页）。`status=watch` 是当日有效候选全集（工作台已做跨源 URL 去重与非当日过滤）。

### ② 分批通读

候选可能数百条。按 50–100 条一批通读，每条记住：标题、来源、URL、热度信号。不要跳过——后续合并与判级的质量取决于完整通读。

### ③ 同类合并

把同一事件/主题的跨源候选合并为「组」。一组的成员应是**同一件事的不同报道或不同侧面**；不同事件不要硬凑。每组：
- `id`：自定唯一串（如 `grp-01`）
- `title`：组主题（≤120 字）
- `memberUrls`：成员候选的 url（≤100 条）
- `representativeUrl`：最有代表性的成员 url
- `sources`：来源名列表

单条无同伴的候选也各成一组（成员 1 条）。

### ④ 判级：strong / potential / none + 理由

对每组判注意力等级（编辑立场：先回答「这会改变读者明天做什么」，参考 editorial-research 包）：

- **strong**：与受众（AI 工具向个人创作者/职场人）高度相关、有具体变化或可执行切入点、通常多源交叉或数据支撑
- **potential**：方向相关但信息不足/单一来源/需要观察——值得挂池，不值得立刻出选题
- **none**：纯娱乐八卦/时政民生/与 AI 创作无关——归档，不占名额

`reason` 必须带具体依据（数据、多源交叉、事件连续性），不要只写「相关」。

**判级标准与示例见 references/grading-examples.md。**

### ⑤ 组写回

```
PUT $BASE/agent/triage/groups
{ "jobId": "collectall-$D", "groups": [ { id, title, attention, reason, memberUrls, representativeUrl, sources, angles, appGap } ] }
```

- 分批写也安全（同 id 覆盖、未出现的旧组保留——增量合并语义）
- `angles`：内容角度草案，platform ∈ 九平台（gzh/tiebuhao/xhs-note/xhs-video/threads/x/facebook/instagram/linkedin），每平台一条角度句（有注意力的组给 1–3 个平台角度）
- `appGap`：如果这个事件指向一个可做的应用/工具缺口，用一句话写出来（没有就不填）

### ⑥ 归档 none 组

```
PUT $BASE/agent/triage/archive
{ "jobId": "collectall-$D", "groups": [ { id, title, memberUrls } ] }
```

把判 none 的组写进归档（工作台里可查可恢复，不静默丢弃）。

### ⑦ 有注意力的组出选题大纲（一个选题一条）

**核心口径（R10.35，老大 2026-10-30 拍板）：不要针对每个平台各写一份大纲。**
一条大纲 = 一个选题方向（讲什么、怎么讲），用 `platforms` 标注它适合投放到哪几个平台，
平台层面的差异（标题风格、篇幅、语气、分发策略）写进 `recommendation` 一句话推荐建议里。

先查重（两道，都由工作台在写入时强制，但你要有意识）：
- **标题级**：48h 内同标题（含全角/大小写变体）会被判 duplicate
- **语义级**：与前 48h（不含当日）的组摘要向量相似度 >0.92 会被判 duplicate——**昨日/前日已有同事件组时，不要重复出题，挂到既有事件线上**（可用 `POST $BASE/agent/vectors/search {"index":"eventline","text":"<标题>","topK":5}` 检索历史事件线）

对每个有注意力的组（strong 与 potential 都要，按组的实际价值定），先 `PUT $BASE/agent/clusters` 建簇（`topic`=组标题、`kind`∈news/newtech/oss/selfproduct/thinking/hot），再出大纲：

```
PUT $BASE/agent/outlines
{
  "clusterId": "<簇id>",
  "platforms": ["gzh", "xhs-note"],          // 适合平台，1-4 个，按事件适配度选，不硬凑
  "recommendation": "<推荐建议一句话：为什么这么写、主投哪个平台、各平台怎么适配>",
  "contentType": "长文",
  "title": "<选题句：带判断/承诺/角度，不是主题词>",
  "outline": [...],                           // 大纲方向 3-8 项，写具体材料/例子/问题
  "keyPoints": [...],
  "evidenceRefs": [组内url]
}
```

**平台适配（写进 recommendation，不再各写一份大纲）**
- **gzh**：完整论证；标题给判断句或承诺句；3-8 项递进
- **tiebuhao**：图卡组（3-6 张）；首图即观点；每张文案 ≤54 字
- **xhs-note**：清单体/教程体；标题带可收藏价值点
- **threads**：中文选题的英文短评改写（≤500 字符）

范例见 `references/outline-samples.md`。**一个组最多出一条大纲**——同一事件不要按平台拆成多条。

### ⑧ appGap 机会卡

有应用缺口的组：

```
PUT $BASE/agent/opportunities
{ "title": "<缺口一句话>", "oneLiner": "<为什么现在做>", "form": "web-app", "url": "<代表url>" }
```

`form` 必填六值之一：web-app / site-group / mobile-app / mini-program / tool / open-source。

### ⑨ 回执 + 完成校验

跑完必须自检，缺一项即失败：
1. `GET $BASE/agent/triage/groups?jobId=collectall-$D` → 当日组存在且数量合理
2. `GET $BASE/agent/vectors/status?jobId=collectall-$D` → 向量索引标记（`indexed` 应等于组数；`marked:false` 表示组写回未触发索引，重写一次组）
3. 大纲无重复（第二步写回时 duplicate 响应已跳过的不算失败）

最后回执：
```
POST $BASE/agent/consume-report  { "consumed": <处理候选数>, "note": "<一句话今日概况>" }
```

## 纪律

- **拍板权不在你**：decision 只能由人在审查台完成，任何写口都写不进 decision 字段
- **跨日去重是硬要求**：同一事件连续多日报道时，只在事件有新进展的那天出新选题，其余挂既有线
- **失败要暴露**：组写回断链时停止后续步骤并输出失败详情，不要静默继续
- 全流程除你自己的模型调用外，工作台侧零额外 AI 消耗
