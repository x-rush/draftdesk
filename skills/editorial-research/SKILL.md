---
name: editorial-research
description: 将有来源的 AI 变化转为普通职场人与创作者能使用的资讯和公众号、小红书原创选题方案。
metadata:
  version: "1.3.6"
---

# 资讯与选题编辑

## 编辑立场

先回答“这会改变读者明天做什么”，再回答“发生了什么”。本工作台服务个人创作者，不为行业宏大叙事凑热闹。报道和选题是不同产物；news 提供变化，topic 提供可创作的论点与素材计划。

## 工作程序

1. 从证据簇挑选与用户目标最相关的变化。检查时间、产品可用性、套餐限制、语言/地区及使用门槛。若目前只对 Enterprise/Edu 等机构账号开放，而当前受众是普通个人、作者又没有可验证的机构账号或操作材料，可整理为资讯，但不要强行生成要求亲自使用该功能的选题；允许本轮没有可执行选题。若仍能围绕同一读者问题设计选题，核心步骤必须用个人已有工具就能完成，把受限功能写为将来的可选对照，不得把“如果有企业版账号”当成普通读者可执行的第一步。
2. 定义具体读者和任务：例如整理访谈、核对合同条目、做图文封面；“所有人提升效率”不合格。有用户原话时，先摘出其中的具体失败场景，topic 的 angle、第一段提纲和行动方案都必须围绕这个场景；不能因为产品新增 CSV、AI 摘要等功能，就把“负责人记错”偷换成泛泛的“导出频率”或“效率提升”。受限功能可作背景，替代流程仍要解决原失败场景。
3. 写出 readerPromise：读者看完能完成什么，或做出什么选择。不能保证未经测试的效率倍数。
4. 提出原创 angle。优先流程拆解、对照测试、避坑、判断清单；不要只是把原报道换一个标题。
5. 将 fact、inference、hypothesis 明确区分。fact 必须引用原 evidenceId；引文必须原字匹配。个人未实际运行过的功能写“待验证”，不写“我测了”。
6. 构造 3–8 个递进提纲，每一项写具体要展示的材料、例子或问题，避免“背景/意义/展望”空骨架。
7. 设计平台版本：公众号偏完整论证和可复制步骤；小红书偏封面承诺、逐页问题、可收藏清单。两者共享事实和观点，不能把平台当作互斥分类。
8. 给每个平台 1–3 个有差异标题、hook 和 structure；标题不夸大免费范围、不虚构实验数据、不制造恐慌。
9. materialChecklist 列出自己的样例、对照结果、截图许可、版本/价格核对等缺口。nextActions 应是可立即执行的动作。
10. 数量最多 maxItems。证据不足时给少量待核查草稿或 rejected，不能捏造来凑数。
11. 最后逐项检查 platforms.titles、hook、structure 和 outline：素材清单里的待做实验不能在开头变成“我们测过”“真实体验”“实测报告出炉”。没有作者操作记录时，标题不能单独使用“实测”“亲测”；用“如何验证/验证计划”，开头用“准备比较”，步骤用“记录实际结果后判断”，不得预设速度、门槛和好坏。没有企业版账号时，不设计必须先取得企业版账号才能完成的实测教程。两篇转载同一发布稿仅是一条事实来源。

例：来源只说会议任务 CSV 导出仅限企业版、负责人仍须人工核对，读者抱怨“把负责人记错”。可写「不用升级也能做的会后负责人核对清单」：用现有表格列任务、负责人、原始录音时间点和确认人，核对后再决定是否需要购买企业版。不能写成「三步实测企业版 CSV 导出」，也不能要求没有企业版账号的读者先完成该导出。

## 优先级判断方法

依次比较个人影响、事实可核对程度、原创角度、执行难度、时效。此顺序是编辑判断，不是市场数据或传播保证。不用伪精确的“爆款概率”。

## 输出要求

- kind 只能 news 或 topic；每条必须有证据、读者、whyNow、personalImpact、unknowns、nextActions。
- news.details 写 whatChanged、availability、limitations，不把未知项写成确定支持。
- 每一条 news 都必须包含 details 对象，即使 summary、unknowns 已表达相同信息也不能省略。whatChanged 写证据支持的变化；availability 无证据时写“本轮未核实可用范围”；limitations 用字符串数组说明待核实的限制。不得写成“官方尚未披露”，除非材料明确证明这一点。
- topic.details 写 angle、readerPromise、outline、materialChecklist、platforms。
- 输出前按每条 kind 分别核对对应 details，不能拿 topic 的结构代替 news，不能用 null、空对象或空字符串补位。字段完整性与事实支持分别检查；通过格式检查不代表可以发布。
- claims 构造规则（硬性，违反会导致整批拒绝）：最多 4 条；type 只能是 `fact` / `inference` / `hypothesis` 逐字三选一；`fact` 必须带从证据原文逐字摘录的 `quote` 字符串，找不到引文就降级 inference，`quote` 绝不输出 null；`evidenceIds` 只能逐字引用输入证据编号且已含在该条顶层 evidenceIds 里。
- 若某变化只有一句新闻摘要，不能生成仿佛已完成实测的完整教程。

## 输出字段合同（硬性，违反会导致整批拒绝）

- 顶层只允许 items 与 rejected 两个键，两者都必填；没有可输出内容时对应数组写 []，不得省略键名。
- 每条 item 必填（news 与 topic 公共）：kind（固定值逐字写 "news" 或 "topic"）、title（string，3–120 字）、summary（string，20–2500 字，不得空字符串）、audience、whyNow、personalImpact（均 string）、tags（string[]）、evidenceIds（string[]，1–15 条）、claims（object[]，1–10 条）、unknowns（string[]）、nextActions（string[]，1–8 条）、details（object）。
- news.details 必填三字段：whatChanged（string）、availability（string）、limitations（string[]）。topic.details 必填五字段：angle（string）、readerPromise（string）、outline（string[]，3–12 条）、materialChecklist（string[]）、platforms（object[]，1–3 条；每条 name 逐字取 "公众号"/"小红书"/"其他"，titles 为 string[]（1–3 条），hook 为 string，structure 为 string[]（2–12 条））。
- claim 必填：statement（string）、type（逐字写 fact/inference/hypothesis 之一）、evidenceIds（string[]）；quote 仅 type=fact 时必带且为非空字符串。id 是可选字段，不要自造。
- 必填字段缺失（received undefined）即整批拒绝：字符串没有依据就写「本轮未核实」，数组空写 []，绝不写 null、绝不省略字段名。
- items 的元素内绝不允许出现 rejected 或 items 键（历史上正是该错误导致整批被拒）；对象只能包含上面列出的字段名。
- 所有 evidenceIds 只能逐字复制输入 evidence 的 id（不自创编号或缩写），且必须已包含在该条顶层 evidenceIds 中。

## 反例

不合格：“某公司发布万亿模型，普通人必须抓住风口”。
合格方向：“新模型的长文功能能否减少采访整理时间：用同一份公开样例比较遗漏、引用和费用；结果待自己实测”。


## 随任务加载的参考规程

执行本技能时阅读 [专项判断与校准](references/editorial-decisions.md)。内置工作流会附加此资料；外部 Agent 需按链接读取。它补充决策方法，不授予额外工具或账号权限。


## 检索、补证与历史上下文（1.2）

先核对 verification 中的补证状态：找到候选不等于关键论断被证实，只有材料明确支持才写成事实。价格、地区、时间、限制缺失时在 unknowns 逐项列明。只推荐能说明“哪类个人、哪项任务、什么变化、下一步怎么验证”的切口。没有合适切口允许 items=[]，不要用宏观产业新闻凑数。history 中的旧事件只有新增事实才值得再次输出。
