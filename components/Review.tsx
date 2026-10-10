"use client";
import { useEffect, useMemo, useState } from "react";
import { api, Field, formatApiError, date } from "./ui";
import { OutlineDrawer } from "./views/OutlineQueueView";
import { creationLabels } from "../core/workspace-ui";

// 审查台（决策层 UI）：队列视图 + 多选批量拍板 + 手动添加选题 + 成稿回填 + 簇/大纲 + 人设配置。
// 语义红线：quality 是证据可信度（AI 判），decision 是要不要写（人拍板）——两层不互相推导。
type Row = {
  sourceType: string; id: string; kind: string; title: string; summary?: string; quality?: string;
  decision: string; platforms?: string[]; rejectReason?: string; publishedRef?: string;
  suggestions?: { by: string; verdict: string; score?: number; reason?: string }[];
  producedBy?: string;
  draftBody?: string;
  creationStatus?: string;
  createdAt: string; evidenceCount?: number; clusterId?: string;
};
const STATUSES = ["pending", "approved", "drafting", "published", "rejected", "deferred"] as const;
const statusLabels: Record<string, string> = {
  pending: "待决策", approved: "已通过", drafting: "写作中", published: "已发布", rejected: "已否决", deferred: "已暂缓",
};
const rejectReasons = ["no-ai-signal", "off-domain", "写不透", "不感兴趣", "已写过", "其他"];
const qualityLabels: Record<string, string> = { review: "待核验", ready: "已核验", rejected: "已否" };
function producedByLabel(by?: string): string {
  if (!by) return "";
  if (by === "human") return "人工";
  if (by === "builtin-ai" || by.startsWith("builtin")) return "内置 AI";
  if (by.startsWith("agent:")) return by.slice(6);
  return by;
}
const sourceFilterLabels: Record<string, string> = { artifact: "内置产物", outline: "大纲", manual: "手动" };

export function Review() {
  const [rows, setRows] = useState<Row[]>([]);
  const [detail, setDetail] = useState<any>(null);
  const [status, setStatus] = useState<string>("pending");
  const [sourceFilter, setSourceFilter] = useState("all");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [batchReason, setBatchReason] = useState("no-ai-signal");
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  const [manual, setManual] = useState({ title: "", notes: "", platforms: "" });
  const [publishRef, setPublishRef] = useState<Record<string, string>>({});
  const [draftText, setDraftText] = useState<Record<string, string>>({});
  const [persona, setPersona] = useState<any>(null);
  const [personaText, setPersonaText] = useState("");
  const [aiPolicy, setAiPolicy] = useState<any>(null);
  const [outlineForm, setOutlineForm] = useState({ clusterId: "", platform: "公众号", contentType: "长文", title: "" });
  const [clusters, setClusters] = useState<any[]>([]);
  // 布局专项④：否决原因选择器仅在点了「否决」后展开；筛选器收进弹出面板
  const [reasonOpen, setReasonOpen] = useState<Set<string>>(new Set());
  const [rowReason, setRowReason] = useState<Record<string, string>>({});

  async function reload() {
    const [list, stats, clustersRes] = await Promise.all([
      api<{ items: Row[] }>("decisions"),
      api<any>("decisions/stats"),
      api<{ items: any[] }>("clusters"),
    ]);
    setRows(list.items);
    setClusters(clustersRes.items);
    return stats;
  }
  useEffect(() => {
    void (async () => {
      try {
        await reload();
        const p = await api<any>("persona");
        setPersona(p);
        setPersonaText(p ? JSON.stringify(p, null, 2) : "");
        setAiPolicy(await api<any>("aiPolicy"));
      } catch (e) { setError(formatApiError(e)); }
    })();
  }, []);

  async function act(fn: () => Promise<void>) {
    setBusy(true); setError(""); setNotice("");
    try { await fn(); } catch (e) { setError(formatApiError(e)); } finally { setBusy(false); }
  }
  const stats = useMemo(() => {
    const byDecision: Record<string, number> = {};
    rows.forEach((r) => { byDecision[r.decision] = (byDecision[r.decision] || 0) + 1; });
    return byDecision;
  }, [rows]);
  const visible = rows.filter((r) => (status === "all" ? true : r.decision === status)).filter((r) => sourceFilter === "all" || r.sourceType === sourceFilter);

  async function batch(decision: string) {
    if (!selected.size) return setNotice("先勾选要拍板的条目。");
    if (decision === "rejected" && !rejectReasons.includes(batchReason)) return;
    await act(async () => {
      const r = await api<{ applied: number; failed: any[] }>("decisions/batch", {
        ids: [...selected], decision, ...(decision === "rejected" ? { rejectReason: batchReason } : {}),
      });
      await reload();
      setSelected(new Set());
      setNotice(`已批量拍板 ${r.applied} 条${r.failed.length ? `，失败 ${r.failed.length} 条` : ""}。rejected/published 的条目已自动消费。`);
    });
  }
  async function decide(row: Row, decision: string, reason?: string) {
    await act(async () => {
      const path = row.sourceType === "artifact" ? `artifacts/${row.id}/decision` : `decisions/${row.id}/decision`;
      await api(path, { decision, ...(decision === "rejected" ? { rejectReason: reason || "其他" } : {}) });
      await reload();
    });
  }
  async function publish(row: Row) {
    const publishedRef = publishRef[row.id]?.trim();
    if (!publishedRef) return setNotice("先填写发布链接再回填。");
    await act(async () => {
      await api(`decisions/${row.id}/publish`, { publishedRef });
      await reload();
      setNotice("已回填发布链接，条目转为已发布并自动消费。");
    });
  }
  async function addManual() {
    if (!manual.title.trim()) return setNotice("标题必填。");
    await act(async () => {
      await api("decisions/manual", { title: manual.title.trim(), notes: manual.notes.trim() || undefined, platforms: manual.platforms ? manual.platforms.split(/[,，]/).map((s) => s.trim()).filter(Boolean) : undefined });
      setManual({ title: "", notes: "", platforms: "" });
      await reload();
      setNotice("手动选题已进入待决策队列。");
    });
  }
  async function saveAiPolicy(next: any) {
    await act(async () => {
      const saved = await api<any>("aiPolicy", next);
      setAiPolicy(saved);
      setNotice("内置 AI 参与开关已保存：triage=" + saved.triage + "，outline=" + saved.outline + "，draft=" + saved.draft + "。off 的环节产出可为空，由外部 Agent 或人补。");
    });
  }
  async function savePersona() {
    await act(async () => {
      const parsed = JSON.parse(personaText);
      await api("persona", parsed);
      setPersona(parsed);
      setNotice("人设配置已保存；之后的 AI 分析将按此个性化判断。");
    });
  }
  async function addOutline() {
    if (!outlineForm.clusterId || !outlineForm.title.trim()) return setNotice("选择簇并填写标题。");
    await act(async () => {
      await api("outlines", { ...outlineForm, title: outlineForm.title.trim() });
      await reload();
      setNotice("大纲已创建，进入待决策队列。");
    });
  }

  return (
    <div>
      {error && <p role="alert" className="error">{error}</p>}
      {notice && <p role="status" className="notice">{notice}</p>}

      <section className="surface page-list">
        <div className="page-header" style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "var(--s2)" }}>
          <h2 style={{ margin: 0 }}>决策队列</h2>
          <details className="help-bubble">
            <summary className="button" aria-label="拍板规则说明" style={{ padding: "5px 10px" }}>？规则</summary>
            <span className="help-pop">建议可以多源，拍板只能一个。quality 是证据可信度（AI 判），decision 是要不要写（这里拍）；否决/发布后会自动消费对应热榜，approved/deferred 会保留在待办里。</span>
          </details>
        </div>
        <div className="page-toolbar" style={{ justifyContent: "space-between" }}>
          <div style={{ display: "flex", gap: "var(--s2)", flexWrap: "wrap" }} role="tablist" aria-label="决策状态筛选">
            {["pending", ...STATUSES.filter((s) => s !== "pending"), "all"].map((s) => (
              <button key={s} className={status === s ? "active" : ""} onClick={() => setStatus(s)}>
                {s === "all" ? `全部 ${rows.length}` : `${statusLabels[s]} ${stats[s] || 0}`}
              </button>
            ))}
          </div>
          <details className="filters-popover">
            <summary className="button" aria-label="筛选与批量操作">筛选与批量（已选 {selected.size}）</summary>
            <div className="popover-panel">
              <Field label="来源筛选">
                <select aria-label="来源筛选" value={sourceFilter} onChange={(e) => setSourceFilter(e.target.value)}>
                  <option value="all">全部来源</option>
                  <option value="artifact">内置产物</option>
                  <option value="outline">大纲</option>
                  <option value="manual">手动</option>
                </select>
              </Field>
              <Field label="批量否决原因">
                <select aria-label="批量否决原因" value={batchReason} onChange={(e) => setBatchReason(e.target.value)}>
                  {rejectReasons.map((r) => <option key={r} value={r}>{r}</option>)}
                </select>
              </Field>
              <div className="card-actions">
                <button className="primary" disabled={busy || !selected.size} onClick={() => void batch("approved")}>批量通过</button>
                <button className="button-secondary" disabled={busy || !selected.size} onClick={() => void batch("deferred")}>批量暂缓</button>
                <button disabled={busy || !selected.size} onClick={() => void batch("rejected")}>批量否决</button>
              </div>
            </div>
          </details>
        </div>
        {visible.length === 0 && <p>该状态下暂无条目。</p>}
        {visible.map((row) => {
          const cluster = clusters.find((c) => c.id === row.clusterId);
          return (
          <div className="review-row card-row" key={row.id}>
            <div className="card-row-top">
              <label className="check">
                <input
                  type="checkbox"
                  aria-label={`选择 ${row.title}`}
                  checked={selected.has(row.id)}
                  onChange={(e) => {
                    const next = new Set(selected);
                    if (e.target.checked) next.add(row.id); else next.delete(row.id);
                    setSelected(next);
                  }}
                />
              </label>
              {row.sourceType === "outline" ? (
                <button className="article-title" onClick={() => setDetail(row)}>{row.title}</button>
              ) : (
                <strong className="card-title">{row.title}</strong>
              )}
              <span className="card-badges">
                <span className="creation-badge">{sourceFilterLabels[row.sourceType] || row.sourceType}</span>
                <span className="creation-badge">{row.kind}</span>
                <span className="creation-badge">{statusLabels[row.decision]}</span>
                {row.quality && <span className="creation-badge">证据可信度 {qualityLabels[row.quality] || row.quality}</span>}
                {row.creationStatus && row.creationStatus !== "inbox" && <span className="creation-badge">{(creationLabels as Record<string,string>)[row.creationStatus] || row.creationStatus}</span>}
                {row.rejectReason && <span className="creation-badge">否决原因 {row.rejectReason}</span>}
              </span>
            </div>
            {row.summary && <p className="card-summary">{row.summary.slice(0, 200)}</p>}
            <div className="card-row-bottom">
              <span className="card-meta">
                {row.createdAt ? date(row.createdAt) : ""}
                {row.evidenceCount !== undefined ? ` · 证据 ${row.evidenceCount} 条` : ""}
                {row.producedBy ? ` · ${producedByLabel(row.producedBy)}` : ""}
                {cluster ? ` · 簇：${cluster.topic}` : ""}
                {row.suggestions && row.suggestions.length > 0 ? " · " + row.suggestions.map((s) => `${s.by} ${s.score ? s.score + "分" : statusLabels[s.verdict] || s.verdict}`).join(" / ") : ""}
              </span>
              <span className="card-actions">
                {row.decision === "pending" && (
                  <>
                    <button className="primary" disabled={busy} onClick={() => void decide(row, "approved")}>通过</button>
                    <button className="button-secondary" disabled={busy} onClick={() => void decide(row, "deferred")}>暂缓</button>
                    {reasonOpen.has(row.id) ? (
                      <>
                        <select aria-label={`否决原因 ${row.title}`} value={rowReason[row.id] || ""} onChange={(e) => setRowReason({ ...rowReason, [row.id]: e.target.value })}>
                          <option value="">否决原因…</option>
                          {rejectReasons.map((r) => <option key={r} value={r}>{r}</option>)}
                        </select>
                        <button disabled={busy || !rowReason[row.id]} onClick={() => { void decide(row, "rejected", rowReason[row.id]); setReasonOpen(new Set([...reasonOpen].filter((x) => x !== row.id))); }}>确认否决</button>
                        <button className="button-secondary" onClick={() => setReasonOpen(new Set([...reasonOpen].filter((x) => x !== row.id)))}>取消</button>
                      </>
                    ) : (
                      <button disabled={busy} onClick={() => setReasonOpen(new Set([...reasonOpen, row.id]))}>否决</button>
                    )}
                  </>
                )}
                {["approved", "drafting"].includes(row.decision) && (
                  <>
                    <button disabled={busy} onClick={() => void decide(row, "drafting")}>开始写作</button>
                    <input
                      aria-label={`发布链接 ${row.title}`}
                      placeholder="发布后回填链接"
                      value={publishRef[row.id] || ""}
                      onChange={(e) => setPublishRef({ ...publishRef, [row.id]: e.target.value })}
                      style={{ maxWidth: 220 }}
                    />
                    <button disabled={busy} onClick={() => void publish(row)}>回填发布</button>
                  </>
                )}
              </span>
            </div>
            {row.decision === "published" && row.publishedRef && (
              <p><a href={row.publishedRef} target="_blank" rel="noreferrer">{row.publishedRef}</a></p>
            )}
            {["approved", "drafting", "published"].includes(row.decision) && (
              <details className="row-fold">
                <summary>草稿正文（可直接读、改、发布）</summary>
                <Field label="草稿正文">
                  <textarea
                    rows={6}
                    value={draftText[row.id] ?? row.draftBody ?? ""}
                    onChange={(e) => setDraftText({ ...draftText, [row.id]: e.target.value })}
                  />
                </Field>
                {row.decision !== "published" && (
                  <button disabled={busy} onClick={() => void act(async () => {
                    await api(`decisions/${row.id}/draft`, { draftBody: draftText[row.id] ?? "" });
                    await reload();
                    setNotice("草稿正文已保存。");
                  })}>保存草稿</button>
                )}
              </details>
            )}
          </div>
          );
        })}
      </section>

      <section className="surface">
        <h2>手动添加选题</h2>
        <Field label="标题">
          <input value={manual.title} onChange={(e) => setManual({ ...manual, title: e.target.value })} />
        </Field>
        <Field label="笔记（可选）">
          <textarea rows={2} value={manual.notes} onChange={(e) => setManual({ ...manual, notes: e.target.value })} />
        </Field>
        <Field label="平台（逗号分隔，可选）">
          <input value={manual.platforms} onChange={(e) => setManual({ ...manual, platforms: e.target.value })} />
        </Field>
        <button className="primary" disabled={busy} onClick={() => void addManual()}>加入待决策队列</button>
      </section>

      <section className="surface">
        <h2>内容簇与多平台大纲</h2>
        <p className="muted">多条同类资讯合并为一个簇；一个簇可产出多份不同平台的大纲，各自独立拍板。AI 自动聚合即将上线，当前支持手动登记。</p>
        <p className="muted">已有簇 {clusters.length} 个{clusters.length ? "：" + clusters.slice(0, 5).map((c) => c.topic + "（" + (c.producedBy || "human") + "）").join("、") : ""}</p>
        <Field label="簇 ID">
          <select value={outlineForm.clusterId} onChange={(e) => setOutlineForm({ ...outlineForm, clusterId: e.target.value })}>
            <option value="">选择内容簇…</option>
            {clusters.map((c) => <option key={c.id} value={c.id}>{c.topic}（{c.memberCount} 条）</option>)}
          </select>
        </Field>
        <Field label="平台">
          <input value={outlineForm.platform} onChange={(e) => setOutlineForm({ ...outlineForm, platform: e.target.value })} />
        </Field>
        <Field label="内容类型">
          <input value={outlineForm.contentType} onChange={(e) => setOutlineForm({ ...outlineForm, contentType: e.target.value })} />
        </Field>
        <Field label="大纲标题">
          <input value={outlineForm.title} onChange={(e) => setOutlineForm({ ...outlineForm, title: e.target.value })} />
        </Field>
        <button disabled={busy} onClick={() => void addOutline()}>创建大纲</button>
      </section>

      <section className="surface">
        <h2>内置 AI 参与开关（aiPolicy）</h2>
        <p className="muted">off = 该环节内置 AI 完全不跑、零开销，产出字段留空等外部 Agent（经 /api/v1/agent/clusters、/outlines 写回）或人补。开关是「谁来干」，不是「干不干」。</p>
        {aiPolicy && (
          <div className="toolbar">
            <Field label="初筛 / 打标 / 聚合分类">
              <select value={aiPolicy.triage} onChange={(e) => void saveAiPolicy({ ...aiPolicy, triage: e.target.value })}>
                {["off", "cheap", "full"].map((v) => <option key={v} value={v}>{v}</option>)}
              </select>
            </Field>
            <Field label="多平台大纲生成">
              <select value={aiPolicy.outline} onChange={(e) => void saveAiPolicy({ ...aiPolicy, outline: e.target.value })}>
                {["off", "cheap", "full"].map((v) => <option key={v} value={v}>{v}</option>)}
              </select>
            </Field>
            <Field label="草稿正文">
              <select value={aiPolicy.draft} onChange={(e) => void saveAiPolicy({ ...aiPolicy, draft: e.target.value })}>
                {["off", "cheap", "full"].map((v) => <option key={v} value={v}>{v}</option>)}
              </select>
            </Field>
            <Field label="写作方">
              <select value={aiPolicy.aiWriter} onChange={(e) => void saveAiPolicy({ ...aiPolicy, aiWriter: e.target.value })}>
                {["builtin", "external", "both"].map((v) => <option key={v} value={v}>{v}</option>)}
              </select>
            </Field>
          </div>
        )}
      </section>

      <section className="surface">
        <h2>人设配置（AI 个性化判断输入）</h2>
        <p className="muted">
          领域边界 / 目标 / 平台规则 / 六维权重与阈值 / 硬红线 / 文风。改这里，AI 的判断随之变化；
          这是配置，不是写死的业务规则。
        </p>
        <textarea
          className="code"
          style={{ width: "100%", minHeight: 260, whiteSpace: "pre-wrap" }}
          aria-label="人设配置 JSON"
          value={personaText}
          onChange={(e) => setPersonaText(e.target.value)}
        />
        <button className="primary" disabled={busy} onClick={() => void savePersona()}>保存人设配置</button>
      </section>
      {detail && (
        <OutlineDrawer
          outline={detail}
          cluster={clusters.find((c) => c.id === detail.clusterId)}
          onClose={() => setDetail(null)}
          onDecide={async (decision, rejectReason) => {
            await decide(detail, decision, rejectReason);
            const refreshed = rows.find((x) => x.id === detail.id);
            setDetail(refreshed && refreshed.decision !== detail.decision ? refreshed : null);
          }}
        />
      )}
    </div>
  );
}
