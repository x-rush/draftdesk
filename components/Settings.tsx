"use client";
// 模型与设置 · 信号台版（完全重设计批）：
// ① 统计条（今日调用/今日 tokens+占比 accent/昨日 tokens/升档——model-metrics 台账）
// ② dash-label 分节：🔌 模型接入（测试就近）→ 💰 预算与成本看板 → 🔍 搜索（测试就近）
//    → 🤖 执行方 → 🎯 内容方向 → 🗂 数据健康（全集合核对）→ ⚠️ 危险操作。
// 全部字段与保存逻辑不动，只重排层级；测试按钮从页尾移进各自分区（就近原则）。
import { useEffect, useState } from "react";
import { Plug, Wallet, Search, BarChart3, Bot, Target, Database, TriangleAlert } from "lucide-react";
import { api, Field } from "./ui";
import { Select } from "./Select";

export function Settings({
  config,
  onChange,
}: {
  config: any;
  onChange: () => Promise<void>;
}) {
  const [metrics, setMetrics] = useState<any[]>([]);
  const [collections, setCollections] = useState<{ today: any; yesterday: any } | null>(null);
  const [seoSrc, setSeoSrc] = useState<any>(null);
  const [seoToken, setSeoToken] = useState("");
  const [seoSaving, setSeoSaving] = useState(false);
  useEffect(() => {
    void api<{ items: any[] }>("model-metrics?days=7").then((r) => setMetrics(r.items || [])).catch(() => {});
    void api<{ today: any; yesterday: any }>("collections-report").then(setCollections).catch(() => {});
    void api<any>("seoDataSource").then(setSeoSrc).catch(() => {});
  }, []);
  const [value, setValue] = useState({
    baseUrl: config.baseUrl,
    model: config.model,
    profile: config.profile,
    dailyTokenLimit: config.dailyTokenLimit,
    apiKey: "",
    tavilyKey: "",
    clearApiKey: false,
    clearTavilyKey: false,
    webSearchProvider: config.webSearchProvider || "hybrid",
    searxngUrl: config.searxngUrl || "",
    interestedCategories: config.interestedCategories || [],
  }),
    [busy, setBusy] = useState(false),
    [notice, setNotice] = useState(""),
    [error, setError] = useState("");
  async function act(fn: () => Promise<void>) {
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await fn();
      await onChange();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  const today = metrics[0], yesterday = metrics[1];
  const spike = yesterday && yesterday.tokens > 0 && today.tokens > yesterday.tokens * 1.5;

  return (
    <form
      className="settings-form page-form"
      onSubmit={(e) => {
        e.preventDefault();
        void act(async () => {
          await api("config", value);
          setValue({
            ...value,
            apiKey: "",
            tavilyKey: "",
            clearApiKey: false,
            clearTavilyKey: false,
          });
          setNotice("设置已保存，输入框中的密钥已清空。");
        });
      }}
    >
      {error && <p role="alert" className="error" style={{ marginTop: 0 }}>{error}</p>}
      {notice && <p role="status" className="notice" style={{ marginTop: 0 }}>{notice}</p>}
            {/* ① 统计条（模型台账） */}
      <div className="stat-strip">
        <div className="stat-card accent"><strong>{(today?.tokens ?? 0).toLocaleString()}</strong><span>今日 tokens{spike ? " 🔶 较昨日 +150%+" : ""}</span><small>{today?.calls ?? 0} 次调用 · 占每日上限 {config.dailyTokenLimit ? Math.round(((today?.tokens ?? 0) / config.dailyTokenLimit) * 100) + "%" : "—"}</small></div>
        <div className="stat-card"><strong>{(yesterday?.tokens ?? 0).toLocaleString()}</strong><span>昨日 tokens</span><small>{yesterday?.calls ?? 0} 次调用 · 占上限 {config.dailyTokenLimit ? Math.round(((yesterday?.tokens ?? 0) / config.dailyTokenLimit) * 100) + "%" : "—"}</small></div>
        <div className="stat-card"><strong>{today?.upgrades ?? 0}</strong><span>⬆ cheap→full 升档</span><small>判断类 cheap 连续 2 次不过合同自动升档</small></div>
        <div className="stat-card"><strong>{config.hasApiKey ? "已连接" : "未配置"}</strong><span>模型状态</span><small>{config.model} · {config.hasTavilyKey ? "Tavily 已配置" : "Tavily 未配置"}</small></div>
      </div>

      {/* ② 模型接入 */}
      <p className="dash-label"><Plug size={14} /> 模型接入<span className="dash-label-sub">百炼统一用于分析与讨论；研究、审稿与讨论共用同一模型</span></p>
      <section className="form-section">
        <div className="form-grid-2">
          <Field label="API Base URL">
            <input
              type="url"
              required
              value={value.baseUrl}
              onChange={(e) => setValue({ ...value, baseUrl: e.target.value })}
            />
          </Field>
          <Field label="模型标识">
            <input
              required
              value={value.model}
              onChange={(e) => setValue({ ...value, model: e.target.value })}
            />
          </Field>
        </div>
        <Field
          label={
            "百炼 API Key · " +
            (config.hasApiKey ? "已配置，留空保留" : "尚未配置")
          }
        >
          <input
            type="password"
            autoComplete="new-password"
            value={value.apiKey}
            onChange={(e) => setValue({ ...value, apiKey: e.target.value })}
          />
        </Field>
        <button
          type="button"
          disabled={busy || !config.hasApiKey}
          onClick={() =>
            void act(async () => {
              const r = await api("test-model", {});
              setNotice("已保存配置：" + r.message);
            })
          }
        >
          {busy ? "测试中…" : "测试模型连接"}
        </button>
        <p className="helper-text" style={{ marginBottom: 0 }}>填写百炼 API Key，而非阿里云 AccessKey ID / Secret。模型标识如需更换，注意 .env 的 DRAFTDESK_AI_MODEL 会覆盖此处配置。</p>
      </section>

      {/* ③ 预算与成本看板 */}
      <p className="dash-label"><Wallet size={14} /> 预算与成本看板<span className="dash-label-sub">判断/分类记 cheap，产出记 full；今日 tokens 超昨日 150% 标黄</span></p>
      <section className="form-section">
        <Field
          label="每日模型 token 预留上限"
          hint="覆盖内置研究与讨论；保守预留不返还，可防止连续失败产生无上限调用。不是人民币账单。"
        >
          <input
            type="number"
            min={30000}
            max={2000000}
            required
            value={value.dailyTokenLimit}
            onChange={(e) =>
              setValue({ ...value, dailyTokenLimit: Number(e.target.value) })
            }
          />
        </Field>
        {metrics.length > 0 && (() => {
          return (
            <table style={{ width: "100%", borderCollapse: "collapse", marginTop: 10, fontSize: 13 }}>
              <thead>
                <tr style={{ textAlign: "left", opacity: 0.7 }}>
                  <th style={{ padding: "4px 8px" }}>日期</th><th>调用</th><th>tokens</th><th>cheap</th><th>full</th><th>升档</th><th>占每日上限</th>
                </tr>
              </thead>
              <tbody>
                {metrics.slice(0, 2).map((m, i) => (
                  <tr key={m.id} style={{ background: i === 0 && spike ? "rgba(234,179,8,.14)" : undefined }}>
                    <td style={{ padding: "4px 8px" }}>{i === 0 ? "今日" : "昨日"} {m.id}{i === 0 && spike ? " 🔶" : ""}</td>
                    <td>{m.calls}</td>
                    <td>{m.tokens.toLocaleString()}</td>
                    <td>{m.byPlan?.cheap?.calls ?? 0} 次 / {(m.byPlan?.cheap?.tokens ?? 0).toLocaleString()}</td>
                    <td>{m.byPlan?.full?.calls ?? 0} 次 / {(m.byPlan?.full?.tokens ?? 0).toLocaleString()}</td>
                    <td>{m.upgrades ?? 0}</td>
                    <td>{config.dailyTokenLimit ? Math.round((m.tokens / config.dailyTokenLimit) * 100) + "%" : "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          );
        })()}
        {metrics.length === 0 && <p className="muted" style={{ marginTop: 8 }}>暂无调用记录（有内置模型调用后出现）。</p>}
        <p className="helper-text" style={{ marginBottom: 0 }}>
          零价值调用零容忍：已消费不重跑、空池跳过、联想/竞争度只做高分词。台账保留 35 天。
        </p>
      </section>

      {/* ④ 搜索后端 */}
      <p className="dash-label"><Search size={14} /> 搜索后端<span className="dash-label-sub">hybrid=Tavily 先行 + 本地 SearXNG 补位合并</span></p>
      <section className="form-section">
        <Field
          label="网页搜索后端"
          hint="先走 Tavily，无 Key、请求失败或相关结果不足 3 条时自动用本地 SearXNG 补位合并；仅 SearXNG 则完全不消耗 Tavily 额度。"
        >
          <Select
            value={value.webSearchProvider}
            onChange={(e) =>
              setValue({ ...value, webSearchProvider: e.target.value })
            }
          >
            <option value="hybrid">Tavily 先行 + SearXNG 补位</option>
            <option value="tavily">仅 Tavily</option>
            <option value="searxng">仅 SearXNG（本地）</option>
          </Select>
        </Field>
        {(value.webSearchProvider === "hybrid" || value.webSearchProvider === "searxng") && (
          <Field
            label="SearXNG 地址"
            hint="随工作台内置，默认 http://searxng:8080；自建在其他位置时修改。"
          >
            <input
              type="url"
              placeholder="http://searxng:8080"
              value={value.searxngUrl}
              onChange={(e) => setValue({ ...value, searxngUrl: e.target.value })}
            />
          </Field>
        )}
        <Field
          label={
            "Tavily Key · " +
            (config.hasTavilyKey ? "已配置，留空保留" : "可选，网页搜索需要")
          }
        >
          <input
            type="password"
            autoComplete="new-password"
            value={value.tavilyKey}
            onChange={(e) => setValue({ ...value, tavilyKey: e.target.value })}
          />
        </Field>
        <button
          type="button"
          disabled={busy || (value.webSearchProvider === "tavily" && !config.hasTavilyKey)}
          onClick={() => void act(async () => {
            const r = await api("test-search", {});
            setNotice(r.message);
          })}
        >
          {busy ? "测试中…" : "测试搜索"}
        </button>
      </section>

      {/* ⑤ SEO 数据源（可选增值，哥飞） */}
      <p className="dash-label"><BarChart3 size={14} /> SEO 数据源<span className="dash-label-sub">可选增值数据源（哥飞 SEO 工具箱，会员积分制）——默认关闭零外部调用</span></p>
      <section className="form-section">
        <Field
          label="数据源开关"
          hint="关闭或未填令牌时全流程走免费降级路径：站群候选按「strong + 低竞争」判定并打「价值未验证」徽章；开启并配置后自动升级为全门槛判定（月搜/KD/CPC）+ 综合价值分排序。数据带 90 天新鲜度（gepheiFetchedAt），过期自动回退降级。"
        >
          <Select
            value={seoSrc?.enabled ? "on" : "off"}
            onChange={(e) => setSeoSrc({ ...seoSrc, enabled: e.target.value === "on" })}
          >
            <option value="off">关闭（免费降级路径，零外部调用）</option>
            <option value="on">开启（哥飞 SEO 工具箱，需令牌）</option>
          </Select>
        </Field>
        {seoSrc?.enabled && (
          <>
            <Field label={"哥飞令牌（WEBCAFE_TOKEN） · " + (seoSrc?.hasToken ? "已配置，留空保留" : "未配置——相关功能显示「配置后解锁」")}>
              <input
                type="password"
                autoComplete="new-password"
                value={seoToken}
                onChange={(e) => setSeoToken(e.target.value)}
              />
            </Field>
            <Field label="每日积分预算（三池独立，互不抢占）" hint="内置侧断路器：档位补位链（tier）/指标补查（metrics）/新词采集（collect）各配独立日额度，额度尽自动停、次日恢复。">
              <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 8 }}>
                {([["builtinTierBudget", "档位补位 tier"], ["builtinMetricsBudget", "指标补查 metrics"], ["builtinCollectBudget", "新词采集 collect"]] as const).map(([key, label]) => (
                  <label key={key} style={{ fontSize: 12 }}>
                    <span className="muted">{label}</span>
                    <input
                      type="number"
                      min={1}
                      max={100000}
                      value={seoSrc?.[key] ?? { builtinTierBudget: 60, builtinMetricsBudget: 30, builtinCollectBudget: 100 }[key]}
                      onChange={(e) => setSeoSrc({ ...seoSrc, [key]: Number(e.target.value) })}
                      style={{ width: "100%" }}
                    />
                  </label>
                ))}
              </div>
            </Field>
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
              <button
                type="button"
                disabled={seoSaving}
                onClick={() => {
                  setSeoSaving(true);
                  void api<any>("seoDataSource", {
                    enabled: seoSrc.enabled,
                    builtinTierBudget: Number(seoSrc.builtinTierBudget) || 60,
                    builtinMetricsBudget: Number(seoSrc.builtinMetricsBudget) || 30,
                    builtinCollectBudget: Number(seoSrc.builtinCollectBudget) || 100,
                    ...(seoToken.trim() ? { token: seoToken.trim() } : {}),
                  }).then((r) => { setSeoSrc(r); setSeoToken(""); }).catch(() => {}).finally(() => setSeoSaving(false));
                }}
              >
                {seoSaving ? "保存中…" : "保存 SEO 数据源配置"}
              </button>
              <button
                type="button"
                disabled={seoSaving}
                onClick={() => {
                  setSeoSaving(true);
                  void api<any>("seoDataSource/test", {}).then((r) => setNotice(r.message)).catch((e) => setNotice("测试失败：" + (e as Error).message)).finally(() => setSeoSaving(false));
                }}
              >
                {seoSaving ? "测试中…" : "连接测试"}
              </button>
            </div>
            <p className="helper-text" style={{ marginBottom: 0 }}>
              数据源可选，自行注册：哥飞 SEO 工具箱（seo.web.cafe）会员积分制，仓库不内置任何令牌。
              今日积分消耗（剩余/已用）：tier {(seoSrc?.pools?.find((x: any) => x.pool === "tier")?.budget ?? 60) - (seoSrc?.pools?.find((x: any) => x.pool === "tier")?.used ?? 0)}/{seoSrc?.pools?.find((x: any) => x.pool === "tier")?.used ?? 0} ·
              metrics {(seoSrc?.pools?.find((x: any) => x.pool === "metrics")?.budget ?? 30) - (seoSrc?.pools?.find((x: any) => x.pool === "metrics")?.used ?? 0)}/{seoSrc?.pools?.find((x: any) => x.pool === "metrics")?.used ?? 0} ·
              collect {(seoSrc?.pools?.find((x: any) => x.pool === "collect")?.budget ?? 100) - (seoSrc?.pools?.find((x: any) => x.pool === "collect")?.used ?? 0)}/{seoSrc?.pools?.find((x: any) => x.pool === "collect")?.used ?? 0}
            </p>
          </>
        )}
        {!seoSrc?.enabled && (
          <p className="helper-text" style={{ marginBottom: 0 }}>当前关闭：零外部调用，站群候选全部走免费字段判定（价值未验证徽章）。</p>
        )}
      </section>

      {/* ⑥ 执行方 */}
      <p className="dash-label"><Bot size={14} /> 执行方与参与方<span className="dash-label-sub">谁来干研究：内置管线或外部 Agent 二选一</span></p>
      <section className="form-section">
        <Field label="消费执行方（保存前即时生效）">
          <Select
            value={config.consumerMode || "external"}
            onChange={(e) =>
              void act(async () => {
                await api("consumerMode", { consumerMode: e.target.value });
              })
            }
          >
            <option value="external">外部 Agent（内置初筛与自动回收停用）</option>
            <option value="builtin">内置管线（每晚自动采集与分析）</option>
          </Select>
        </Field>
        <p className="helper-text" style={{ marginBottom: 0 }}>
          当前：{(config.consumerMode || "external") === "external" ? "外部 Agent ｜ 内置初筛与自动回收已停用，改由外部 Agent 经接口写回。" : "内置管线 ｜ 每晚定时采集与分析、自动回收照常运行。"}
          内置 AI 与外部 Agent 各自负责消费链路的不同环节；停用某来源后其已产出的内容仍可查。内置 AI 参与开关（triage / outline / draft / aiWriter 四开关）在审查台「内置 AI 参与开关（aiPolicy）」分区配置。
        </p>
      </section>

      {/* ⑦ 内容方向 */}
      <p className="dash-label"><Target size={14} /> 内容方向<span className="dash-label-sub">受众定位与兴趣类别，影响热点排序与推荐</span></p>
      <section className="form-section">
        <Field label="受众与内容定位">
          <textarea
            required
            rows={4}
            value={value.profile}
            onChange={(e) => setValue({ ...value, profile: e.target.value })}
          />
        </Field>
        <Field label="兴趣类别（可多选）">
          <div style={{ display: "flex", flexWrap: "wrap", gap: 10 }}>
            {(["模型动态", "Agent生态", "图像视频", "开发工具", "成本额度", "教程实战", "其他"] as const).map((cat) => (
              <label className="check" key={cat}>
                <input
                  type="checkbox"
                  checked={(value.interestedCategories || []).includes(cat)}
                  onChange={(e) =>
                    setValue({
                      ...value,
                      interestedCategories: e.target.checked
                        ? [...(value.interestedCategories || []), cat]
                        : (value.interestedCategories || []).filter((c: string) => c !== cat),
                    })
                  }
                />
                {cat}
              </label>
            ))}
          </div>
        </Field>
        <p className="helper-text" style={{ marginBottom: 0 }}>勾选后热点资讯默认把感兴趣的分类置顶；可随时在热点页切换纯时间序。</p>
      </section>

      {/* ⑧ 数据健康 */}
      <p className="dash-label"><Database size={14} /> 数据健康<span className="dash-label-sub">全集合行数快照 · 异动标黄 · 保险丝快照在 data/snapshots/</span></p>
      <section className="form-section">
        {(() => {
          const todayCounts = collections?.today?.counts as Record<string, number> | undefined;
          const yesterdayCounts = collections?.yesterday?.counts as Record<string, number> | undefined;
          if (!todayCounts) return <p className="muted" style={{ margin: 0 }}>今日快照尚未生成（janitor 每日首跑后出现）。</p>;
          const names = [...new Set([...Object.keys(todayCounts), ...Object.keys(yesterdayCounts || {})])].sort();
          return (
            <div style={{ maxHeight: 320, overflowY: "auto" }}>
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
              <thead>
                <tr style={{ textAlign: "left", opacity: 0.7 }}>
                  <th style={{ padding: "4px 8px" }}>集合</th><th>昨日</th><th>今日</th><th>Δ</th>
                </tr>
              </thead>
              <tbody>
                {names.map((name) => {
                  const t = todayCounts[name] ?? 0;
                  const y = yesterdayCounts?.[name] ?? 0;
                  const changed = t !== y;
                  return (
                    <tr key={name} style={{ background: changed ? "rgba(234,179,8,.14)" : undefined }}>
                      <td style={{ padding: "4px 8px" }}>{name}{changed ? " 🔶" : ""}</td>
                      <td>{y}</td>
                      <td>{t}</td>
                      <td>{changed ? (t > y ? "+" : "") + (t - y) : "—"}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            </div>
          );
        })()}
        <p className="helper-text" style={{ marginBottom: 0 }}>
          janitor 每日快照 documents 全集合行数；意外暴增/暴减先看备份（backups/）与保险丝快照（data/snapshots/，保留 3 份）。
        </p>
      </section>

      {/* ⑨ 危险操作 */}
      <p className="dash-label"><TriangleAlert size={14} /> 危险操作</p>
      <section className="danger-zone">
        <label className="check">
          <input
            type="checkbox"
            checked={value.clearApiKey}
            onChange={(e) =>
              setValue({ ...value, clearApiKey: e.target.checked })
            }
          />
          清除已保存的百炼密钥（保存后生效，需重新配置才能调用模型）
        </label>
        <label className="check">
          <input
            type="checkbox"
            checked={value.clearTavilyKey}
            onChange={(e) =>
              setValue({ ...value, clearTavilyKey: e.target.checked })
            }
          />
          清除已保存的搜索密钥（Tavily 网页搜索将不可用）
        </label>
      </section>
      <footer className="form-actions">
        <button className="primary" disabled={busy}>
          {busy ? "处理中…" : "保存设置"}
        </button>
      </footer>
    </form>
  );
}
