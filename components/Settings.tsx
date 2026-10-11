"use client";
// 模型与设置视图（PHASE 5 自 Workbench.tsx 纯移动拆出；JSX 与拆分前逐字一致）。
// 每日成本看板（成本纪律批 7）：近 7 天调用台账（cheap/full 拆分），今日超昨日 150% 标黄。
import { useEffect, useState } from "react";
import { api, Field } from "./ui";

export function Settings({
  config,
  onChange,
}: {
  config: any;
  onChange: () => Promise<void>;
}) {
  const [metrics, setMetrics] = useState<any[]>([]);
  useEffect(() => {
    void api<{ items: any[] }>("model-metrics?days=7").then((r) => setMetrics(r.items || [])).catch(() => {});
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
  return (
    <form
      className="settings-form surface page-form"
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
      <section className="form-section">
        <h2>消费执行方</h2>
        <span className="helper-text">{(config.consumerMode || "external") === "external"
          ? "当前：外部 Agent ｜ 内置初筛与自动回收已停用，改由外部 Agent 经接口写回。"
          : "当前：内置管线 ｜ 每晚定时采集与分析、自动回收照常运行。"}</span>
        <Field label="模式（保存前即时生效）">
          <select
            value={config.consumerMode || "external"}
            onChange={(e) =>
              void act(async () => {
                await api("consumerMode", { consumerMode: e.target.value });
              })
            }
          >
            <option value="external">外部 Agent（内置初筛与自动回收停用）</option>
            <option value="builtin">内置管线（每晚自动采集与分析）</option>
          </select>
        </Field>
      </section>
      <section className="form-section">
        <h2>参与方</h2>
        <span className="helper-text">
          内置 AI 与外部 Agent 各自负责消费链路的不同环节，产出在审查台可按来源筛选；停用某来源后其已产出的内容仍可查，只是不再新增。
        </span>
        <Field label="内置 AI 参与开关">
          <p className="helper-text" style={{ margin: 0 }}>在审查台「内置 AI 参与开关（aiPolicy）」分区配置：triage / outline / draft / aiWriter 四开关。</p>
        </Field>
      </section>
      <section className="form-section">
        <h2>阿里云百炼</h2>
        <span className="helper-text">
          研究、审稿与讨论共用同一模型。填写百炼 API Key，而非阿里云 AccessKey ID / Secret。
        </span>
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
      </section>
      <section className="form-section">
        <h2>每日成本看板</h2>
        <span className="helper-text">
          内置模型调用台账（判断/分类记 cheap，产出记 full；cheap 连续 2 次不过合同自动升 full 重试并记升级）。
          今日 tokens 超昨日 150% 标黄提示。零价值调用零容忍：已消费不重跑、空池跳过、联想/竞争度只做高分词。
        </span>
        {metrics.length > 0 && (() => {
          const today = metrics[0], yesterday = metrics[1];
          const spike = yesterday && yesterday.tokens > 0 && today.tokens > yesterday.tokens * 1.5;
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
                    <td style={{ padding: "4px 8px" }}>{i === 0 ? "今日" : "昨日"} {m.id}{i === 0 && spike ? " 🔶 较昨日 +150%+" : ""}</td>
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
      </section>
      <section className="form-section">
        <h2>我的兴趣类别</h2>
        <span className="helper-text">勾选后热点资讯默认把感兴趣的分类置顶；可随时在热点页切换纯时间序。</span>
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
      </section>
      <section className="form-section">
        <h2>搜索与质量预算</h2>
      <Field
        label="网页搜索后端"
        hint="Tavily 先行 + SearXNG 补位：先走 Tavily，无 Key、请求失败或相关结果不足 3 条时自动用本地 SearXNG 补位合并；仅 SearXNG 则完全不消耗 Tavily 额度。"
      >
        <select
          value={value.webSearchProvider}
          onChange={(e) =>
            setValue({ ...value, webSearchProvider: e.target.value })
          }
        >
          <option value="hybrid">Tavily 先行 + SearXNG 补位</option>
          <option value="tavily">仅 Tavily</option>
          <option value="searxng">仅 SearXNG（本地）</option>
        </select>
      </Field>
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

      <Field label="受众与内容定位">
        <textarea
          required
          rows={4}
          value={value.profile}
          onChange={(e) => setValue({ ...value, profile: e.target.value })}
        />
      </Field>
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
      </section>
      <section className="danger-zone">
        <h2>危险操作</h2>
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
      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
      {notice && (
        <p role="status" className="notice">
          {notice}
        </p>
      )}
      <footer className="form-actions">
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
          测试模型连接
        </button>
        <button type="button" disabled={busy || (config.webSearchProvider || "hybrid") === "tavily" && !config.hasTavilyKey}
          onClick={() => void act(async () => {
            const r = await api("test-search", {});
            setNotice(r.message);
          })}>
          测试搜索
        </button>
        <button className="primary" disabled={busy}>
          {busy ? "处理中…" : "保存设置"}
        </button>
      </footer>
    </form>
  );
}
