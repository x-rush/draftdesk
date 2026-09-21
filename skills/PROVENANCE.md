# 技能来源与质量说明

这些技能是 DraftDesk 的项目适配规程；并非第三方完整 Agent 的原样安装，也不自动执行下载脚本。v1.1 明确改编了下表的内容策划与用户研究方法，其余证据、趋势、人物、讨论与审稿规程为项目原创。没有搬运服务品牌、账号操作和自动推广逻辑。

## 可追溯方法来源（2026-09-21 核对）

| 上游 | 固定来源/版本 | 用途与修改 |
|---|---|---|
| Corey Haines / marketingskills，content-strategy | https://github.com/coreyhaines31/marketingskills/blob/5b2c0007766c6a1cf1d53fd8fc73e979e0821022/skills/content-strategy/SKILL.md ，2.1.1 | 适配读者问题、搜索意图、可分享观点到公众号/小红书简报；去掉 SEO 优先、流量承诺和自动推广 |
| 同仓库 customer-research | https://github.com/coreyhaines31/marketingskills/blob/5b2c0007766c6a1cf1d53fd8fc73e979e0821022/skills/customer-research/SKILL.md ，2.0.2 | 适配用户任务、原话、触发事件、替代方案和反证；不自动访谈或接触用户 |
| 当前环境 skill-creator | 编写时读取本机系统技能；不是模型运行依赖 | 精确适用范围、按需参考资料、格式校验和行为验证 |
| Anthropic skill-creator / evals 工程文章 | https://github.com/anthropics/skills/tree/main/skills/skill-creator 与 https://www.anthropic.com/engineering/demystifying-evals-for-ai-agents ，2026-09-21 阅读 | 参考旧版/新版对照、独立样例、区分规则检查与人工判断的方法；未安装 Claude 运行器、未复制上游评测程序 |

marketingskills 的固定版本采用 MIT 许可，版权与许可全文随包保存在 THIRD-PARTY-NOTICES.md。其他上游仅作方法参考，不声称已原样安装或经过其作者认证。上游知名度和格式合规不构成在 GLM 上的效果证明。

## v1.1 实际加载与验证

每个研究阶段只加载对应 SKILL.md 与登记的 references，不把所有技能塞入一次调用。版本从文件读取，内容散列覆盖入口和参考资料；外部下载包包含同样资料。evals/baseline-v1 保存变更前入口，用于复现对照。

8 个虚构、非生产样例覆盖选题过滤、套餐限制、同源转载、地域口径、购买信号、反例、身份消歧和提示词注入。`npm run eval:skills` 只检查案例清单，不调用模型；真实逐例对照参见 evals/README.md。规则测试通过不表示语义标准已通过，未评项保持 null。

格式依据 https://agentskills.io/specification 。外部安装方式参考 https://docs.openclaw.ai/tools/skills 和 https://hermes-agent.nousresearch.com/docs/guides/work-with-skills 。技能按需加载，版本和内容散列写入每次研究任务。

技能不保证模型正确；必须结合运行时 JSON Schema、来源引用检查、人工审阅与真实模型评测。当前规则型评估不代表已完成真实付费模型质量验收。
