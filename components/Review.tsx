"use client";
import { useEffect, useMemo, useState } from "react";
import { api, Field } from "./ui";

// 审查台（决策层 UI）：队列视图 + 多选批量拍板 + 手动添加选题 + 成稿回填 + 簇/大纲 + 人设配置。
// 语义红线：quality 是证据可信度（AI 判），decision 是要不要写（人拍板）——两层不互相推导。
type Row = {
  sourceType: string; id: string; kind: string; title: string; summary?: string; quality?: string;
  decision: string; platforms?: string[]; rejectReason?: string; publishedRef?: string;
  suggestions?: { by: string; verdict: string; score?: number; reason?: string }[];
  producedBy?: string;
  createdAt: string; evidenceCount?: number; clusterId?: string;
};
const STATUSES = ["pending", "approved", "drafting", "published", "rejected", "deferred"] as const;
const statusLabels: Record<string, string> = {
  pending: "待决策", approved: "已通过", drafting: "写作中", published: "已发布", rejected: "已否决", deferred: "已暂缓",
};
const rejectReasons = ["no-ai-signal", "off-domain", "写不透", "不感兴趣", "已写过", "其他"];

export function Review() {
  const [rows, setRows] = useState<Row[]>([]);
  const [status, setStatus] = useState<string>("pending");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [batchReason, setBatchReason] = useState("no-ai-signal");
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  const [manual, setManual] = useState({ title: "", notes: "", platforms: "" });
  const [publishRef, setPublishRef] = useState<Record<string, string>>({});
  const [persona, setPersona] = useState<any>(null);
  const [personaText, setPersonaText] = useState("");
  const [aiPolicy, setAiPolicy] = useState<any>(null);
  const [outlineForm, setOutlineForm] = useState({ clusterId: "", platform: "公众号", contentType: "长文", title: "" });
  const [clusters, setClusters] = useState<any[]>([]);

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
      } catch (e) { setError((e as Error).message); }
    })();
  }, []);

  async function act(fn: () => Promise<void>) {
    setBusy(true); setError(""); setNotice("");
    try { await fn(); } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  }
  const stats = useMemo(() => {
    const byDecision: Record<string, number> = {};
    rows.forEach((r) => { byDecision[r.decision] = (byDecision[r.decision] || 0) + 1; });
    return byDecision;
  }, [rows]);
  const visible = rows.filter((r) => (status === "all" ? true : r.decision === status));

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
      <p className="muted">
        建议可以多源，拍板只能一个。quality 是证据可信度（AI 判），decision 是要不要写（这里拍）；
        否决/发布后会自动消费对应热榜，approved/deferred 会保留在待办里。
      </p>
      {error && <p role="alert" className="error">{error}</p>}
      {notice && <p role="status" className="notice">{notice}</p>}

      <section className="surface">
        <h2>决策队列</h2>
        <div className="toolbar" role="tablist" aria-label="决策状态筛选">
          {["pending", ...STATUSES.filter((s) => s !== "pending"), "all"].map((s) => (
            <button key={s} className={status === s ? "active" : ""} onClick={() => setStatus(s)}>
              {s === "all" ? `全部 ${rows.length}` : `${statusLabels[s]} ${stats[s] || 0}`}
            </button>
          ))}
        </div>
        <div className="toolbar">
          <button disabled={busy || !selected.size} onClick={() => void batch("approved")}>批量通过</button>
          <button disabled={busy || !selected.size} onClick={() => void batch("deferred")}>批量暂缓</button>
          <button disabled={busy || !selected.size} onClick={() => void batch("rejected")}>批量否决</button>
          <select aria-label="批量否决原因" value={batchReason} onChange={(e) => setBatchReason(e.target.value)} title="否决原因（批量否决时应用）">
            {rejectReasons.map((r) => <option key={r} value={r}>{r}</option>)}
          </select>
          <span className="muted">已选 {selected.size} 条</span>
        </div>
        {visible.length === 0 && <p>该状态下暂无条目。</p>}
        {visible.map((row) => (
          <div className="review-row" key={row.id}>
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
            <div className="review-body">
              <strong>{row.title}</strong>
              <small>
                <span className="creation-badge">{row.sourceType}</span>{" "}
                <span className="creation-badge">{row.kind}</span>{" "}
                <span className="creation-badge">{statusLabels[row.decision]}</span>{" "}
                {row.quality && <span className="creation-badge">证据可信度 {row.quality}</span>}{" "}
                {row.evidenceCount !== undefined && <span className="creation-badge">证据 {row.evidenceCount} 条</span>}{" "}
                {row.producedBy && <span className="creation-badge">producedBy {row.producedBy}</span>}
                {row.rejectReason && <span className="creation-badge">否决原因 {row.rejectReason}</span>}
              </small>
              {row.summary && <p className="muted">{row.summary.slice(0, 200)}</p>}
              {row.suggestions && row.suggestions.length > 0 && (
                <p className="muted">
                  {row.suggestions.map((s, i) => (
                    <span className="creation-badge" key={i} title={s.reason || ""}>
                      {s.by}: {statusLabels[s.verdict] || s.verdict}{s.score ? ` ${s.score} 分` : ""}
                    </span>
                  ))}
                </p>
              )}
              {row.decision === "pending" && (
                <div className="toolbar">
                  <button disabled={busy} onClick={() => void decide(row, "approved")}>通过</button>
                  <button disabled={busy} onClick={() => void decide(row, "deferred")}>暂缓</button>
                  <button disabled={busy} onClick={() => void decide(row, "rejected", "其他")}>否决</button>
                  <select aria-label={`否决原因 ${row.title}`} onChange={(e) => { if (e.target.value) void decide(row, "rejected", e.target.value); e.target.value = ""; }} defaultValue="">
                    <option value="">否决原因…</option>
                    {rejectReasons.map((r) => <option key={r} value={r}>{r}</option>)}
                  </select>
                </div>
              )}
              {["approved", "drafting"].includes(row.decision) && (
                <div className="toolbar">
                  <button disabled={busy} onClick={() => void decide(row, "drafting")}>开始写作</button>
                  <input
                    aria-label={`发布链接 ${row.title}`}
                    placeholder="发布后回填链接"
                    value={publishRef[row.id] || ""}
                    onChange={(e) => setPublishRef({ ...publishRef, [row.id]: e.target.value })}
                  />
                  <button disabled={busy} onClick={() => void publish(row)}>回填发布</button>
                </div>
              )}
              {row.decision === "published" && row.publishedRef && (
                <p><a href={row.publishedRef} target="_blank" rel="noreferrer">{row.publishedRef}</a></p>
              )}
            </div>
          </div>
        ))}
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
    </div>
  );
}
