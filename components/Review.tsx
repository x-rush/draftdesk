"use client";
import { useEffect, useMemo, useState } from "react";
import { api, Field, formatApiError, date } from "./ui";
import { OutlineDrawer } from "./views/OutlineQueueView";
import { PLATFORM_KEYS, PLATFORM_LABELS, platformLabel, aggregateOutlineDecision } from "../core/platforms";
import { MessageContent } from "./MessageContent";
import { Select } from "./Select";
import { creationLabels } from "../core/workspace-ui";

// 审查台（决策层 UI）：队列视图 + 多选批量拍板 + 手动添加选题 + 成稿回填 + 簇/大纲 + 人设配置。
// 语义红线：quality 是证据可信度（AI 判），decision 是要不要写（人拍板）——两层不互相推导。
type Row = {
  sourceType: string; id: string; kind: string; title: string; summary?: string; quality?: string;
  decision: string; platform?: string; category?: string; perPlatformDecision?: Record<string, string>; outline?: string[]; platforms?: string[]; rejectReason?: string; publishedRef?: string;
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
  // 数据治理（根因 B）：同题 pending 聚合——外部 Agent 每轮重写同题 outline，
  // 80+ 条里同题 4-6 连发无法浏览。组内取最新为主行，拍板=批量拍全组。
  const groups = useMemo(() => {
    const byTitle = new Map<string, Row[]>();
    for (const r of visible) {
      const key = r.title.trim();
      const bucket = byTitle.get(key) || [];
      bucket.push(r);
      byTitle.set(key, bucket);
    }
    return [...byTitle.values()]
      .map((members) => {
        const sorted = [...members].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
        return { primary: sorted[0], members: sorted };
      })
      .sort((a, b) => b.primary.createdAt.localeCompare(a.primary.createdAt));
  }, [visible]);
  const expandedGroups = useState<Set<string>>(new Set());
  const [openGroups, setOpenGroups] = expandedGroups;
  const toggleGroup = (title: string) => setOpenGroups((prev) => {
    const next = new Set(prev);
    if (next.has(title)) next.delete(title); else next.add(title);
    return next;
  });
  // 同题×N 不再连拍（第六轮批 B §2①）：组拍板=对组内每个平台行各拍各的平台——
  // 主行写 perPlatformDecision[platform]，同题同平台行由路由行级同步；
  // 跨平台状态互不影响（旧 batch 全组连拍已撤）。
  async function decideGroup(group: { primary: Row; members: Row[] }, decision: string, reason?: string) {
    if (group.primary.sourceType !== "outline") return decide(group.primary, decision, reason);
    await act(async () => {
      let platforms = 0;
      for (const m of group.members) {
        const key = PLATFORM_KEYS.find((k) => PLATFORM_LABELS[k] === m.platform || k === m.platform);
        if (!key) continue;
        await api(`outlines/${m.id}/platform-decision`, { platform: key, decision });
        platforms++;
      }
      await reload();
      setNotice(`已按平台拍板 ${platforms} 个平台（${decision}）——各平台状态独立，可点平台徽章分别改。`);
    });
  }

  // 平台徽章点拍：主行 perPlatformDecision 单平台改状态（其他平台不动）
  async function decidePlatform(row: Row, platform: string, decision: string) {
    await act(async () => {
      await api(`outlines/${row.id}/platform-decision`, { platform, decision });
      await reload();
    });
  }

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

  const statusCards: Array<[string, string, number, boolean]> = [
    ["pending", "待决策", stats.pending || 0, true],
    ["approved", "已通过", stats.approved || 0, false],
    ["drafting", "进行中", (stats.drafting || 0) + (stats.published || 0), false],
    ["rejected", "已否决·暂缓", (stats.rejected || 0) + (stats.deferred || 0), false],
  ];
  return (
    <div>
      {error && <p role="alert" className="error">{error}</p>}
      {notice && <p role="status" className="notice">{notice}</p>}

      {/* ① 统计条（点击切状态档） */}
      <div className="stat-strip">
        {statusCards.map(([key, label, count, accent]) => (
          <button type="button" key={key} className={"stat-card clickable" + (accent ? " accent" : "") + (status === key ? " active" : "")}
            aria-pressed={status === key}
            onClick={() => setStatus(status === key ? "all" : key)}>
            <strong>{count}</strong><span>{label}</span>
            <small>{key === "pending" ? "点卡片只看这一档，再点回全部" : key === "drafting" ? "写作中 " + (stats.drafting || 0) + " · 已发布 " + (stats.published || 0) + " 条" : key === "rejected" ? "暂缓 " + (stats.deferred || 0) + " 条" : "进入写作与发布流转"}</small>
          </button>
        ))}
      </div>

      {/* ② 工具行：状态/来源筛选 + 批量 + 规则 */}
      <div className="radar-toolbar">
        <nav className="discovery-modes" aria-label="决策状态筛选">
          <button className={status === "all" ? "active" : ""} onClick={() => setStatus("all")}>全部 {rows.length}</button>
          {STATUSES.filter((s) => s !== "pending").map((s) => (
            <button key={s} className={status === s ? "active" : ""} onClick={() => setStatus(s)}>{statusLabels[s]} {stats[s] || 0}</button>
          ))}
        </nav>
        <details className="filters-popover" data-popover>
          <summary className="button" aria-label="筛选与批量操作" style={{ marginLeft: "auto" }}>来源与批量（已选 {selected.size}）</summary>
          <div className="popover-panel">
            <Field label="来源筛选">
              <Select aria-label="来源筛选" value={sourceFilter} onChange={(e) => setSourceFilter(e.target.value)}>
                <option value="all">全部来源</option>
                <option value="artifact">内置产物</option>
                <option value="outline">大纲</option>
                <option value="manual">手动</option>
              </Select>
            </Field>
            <Field label="批量否决原因">
              <Select aria-label="批量否决原因" value={batchReason} onChange={(e) => setBatchReason(e.target.value)}>
                {rejectReasons.map((r) => <option key={r} value={r}>{r}</option>)}
              </Select>
            </Field>
            <div className="card-actions">
              <button className="primary" disabled={busy || !selected.size} onClick={() => void batch("approved")}>批量通过</button>
              <button className="button-secondary" disabled={busy || !selected.size} onClick={() => void batch("deferred")}>批量暂缓</button>
              <button disabled={busy || !selected.size} onClick={() => void batch("rejected")}>批量否决</button>
            </div>
          </div>
        </details>
        <details className="help-bubble" data-popover>
          <summary className="button" aria-label="拍板规则说明">？规则</summary>
          <span className="help-pop">建议可以多源，拍板只能一个。quality 是证据可信度（AI 判），decision 是要不要写（这里拍）；否决/发布后会自动消费对应热榜，approved/deferred 会保留在待办里。</span>
        </details>
      </div>

      {/* ③ 决策队列（紧凑行：摘要钳 2 行，拍板键右贴，同题组聚合） */}
      {groups.length === 0 ? (
        <p className="muted" style={{ padding: "18px 2px" }}>该状态下暂无条目。</p>
      ) : (
        <div className="decision-list">
        {groups.map((group) => {
          const row = group.primary;
          const dupCount = group.members.length;
          const cluster = clusters.find((c) => c.id === row.clusterId);
          return (
          <div className="decision-row" key={row.id}>
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
            <div className="decision-main">
              <div className="decision-title-line">
                {row.sourceType === "outline" ? (
                  <button className="decision-title" onClick={() => setDetail(row)}>{row.title}</button>
                ) : (
                  <strong className="decision-title" style={{ cursor: "default" }}>{row.title}</strong>
                )}
                {dupCount > 1 && (
                  <button className="creation-badge" style={{ cursor: "pointer" }} onClick={() => toggleGroup(row.title)}>同题 ×{dupCount}{openGroups.has(row.title) ? " ▲" : " ▼"}</button>
                )}
                {row.quality && <span className="creation-badge">可信度 {qualityLabels[row.quality] || row.quality}</span>}
                {row.draftBody && <span className="creation-badge" style={{ color: "#1a7f4b" }}>有草稿</span>}
                {row.rejectReason && <span className="creation-badge">否决：{row.rejectReason}</span>}
              </div>
              {row.sourceType === "outline" && (
                <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginTop: 4 }} aria-label="按平台拍板">
                  {PLATFORM_KEYS.map((k) => {
                    const st = (row.perPlatformDecision?.[k] || (platformLabel(row.platform) === PLATFORM_LABELS[k] ? row.decision : "pending")) as string;
                    const color = st === "approved" || st === "published" ? "#1a7f4b" : st === "drafting" ? "#8a6d1a" : st === "rejected" ? "#8a3a3a" : undefined;
                    const cycle: Record<string, string> = { pending: "approved", approved: "drafting", drafting: "published", published: "rejected", rejected: "deferred", deferred: "pending" };
                    return (
                      <button key={k} className="pill" style={{ cursor: "pointer", color, borderColor: color }}
                        title={`点击拍板：${PLATFORM_LABELS[k]} → ${statusLabels[cycle[st]] || cycle[st]}（其余平台不受影响）`}
                        disabled={busy} onClick={() => void decidePlatform(row, k, cycle[st] || "pending")}>
                        {PLATFORM_LABELS[k]} · {statusLabels[st] || st}
                      </button>
                    );
                  })}
                </div>
              )}
              {row.summary && <p className="decision-summary" style={{ cursor: "pointer" }} title="点击展开/收起全文" onClick={(e) => { (e.currentTarget as HTMLElement).classList.toggle("open"); }}>{row.summary.slice(0, 400)}</p>}
              <div className="decision-meta">
                <span className="creation-badge" style={{ background: "transparent", padding: 0 }}>{statusLabels[row.decision]}</span>
                <span>{sourceFilterLabels[row.sourceType] || row.sourceType}</span>
                {row.createdAt && <span>{date(row.createdAt)}</span>}
                {row.evidenceCount !== undefined && <span>证据 {row.evidenceCount} 条</span>}
                {row.producedBy && <span>{producedByLabel(row.producedBy)}</span>}
                {cluster && <span>簇：{cluster.topic}</span>}
                {row.suggestions?.length ? <span title={row.suggestions.map((x) => `${x.by} ${x.score ? x.score + "分" : statusLabels[x.verdict] || x.verdict}`).join("；")}>建议 {row.suggestions.length} 条</span> : null}
              </div>
              {row.decision === "published" && row.publishedRef && (
                <div className="decision-meta"><a href={row.publishedRef} target="_blank" rel="noreferrer">{row.publishedRef}</a></div>
              )}
              {dupCount > 1 && openGroups.has(row.title) && (
                <div className="group-members">
                  {group.members.slice(1).map((m) => (
                    <div className="decision-meta" key={m.id} style={{ borderTop: "1px dashed var(--line)", paddingTop: 6, marginTop: 6, display: "flex", justifyContent: "space-between", gap: 8, flexWrap: "wrap" }}>
                      <span>{sourceFilterLabels[m.sourceType] || m.sourceType} · {date(m.createdAt)}{m.evidenceCount !== undefined ? ` · 证据 ${m.evidenceCount} 条` : ""}{m.producedBy ? ` · ${producedByLabel(m.producedBy)}` : ""} · {statusLabels[m.decision]}</span>
                      <span className="decision-actions">
                        {m.decision === "pending" && <>
                          <button className="button-secondary" disabled={busy} onClick={() => void decide(m, "approved")}>通过</button>
                          <button disabled={busy} onClick={() => void decide(m, "rejected", "重复条目")}>否决</button>
                        </>}
                      </span>
                    </div>
                  ))}
                </div>
              )}
              {(row.draftBody || ["approved", "drafting", "published"].includes(row.decision)) && (
                <details className="row-fold">
                  <summary>草稿正文{row.decision === "pending" && row.draftBody ? "（有草稿 · pending 只读预览）" : "（可直接读、改、发布）"}</summary>
                  {row.decision === "pending" ? (
                    <Field label="草稿正文（只读预览——拍板通过后可编辑）">
                      <div className="draft-preview"><MessageContent text={row.draftBody || ""} /></div>
                    </Field>
                  ) : (
                    <>
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
                    </>
                  )}
                </details>
              )}
            </div>
            <div className="decision-actions">
              {row.decision === "pending" && (
                <>
                  <button className="primary" disabled={busy} onClick={() => void decideGroup(group, "approved")}>通过{dupCount > 1 ? ` ×${dupCount}` : ""}</button>
                  <button className="button-secondary" disabled={busy} onClick={() => void decideGroup(group, "deferred")}>暂缓</button>
                  {reasonOpen.has(row.id) ? (
                    <>
                      <Select aria-label={`否决原因 ${row.title}`} placeholder="否决原因…" value={rowReason[row.id] || undefined} onChange={(e) => setRowReason({ ...rowReason, [row.id]: e.target.value })}>
                        {rejectReasons.map((r) => <option key={r} value={r}>{r}</option>)}
                      </Select>
                      <button disabled={busy || !rowReason[row.id]} onClick={() => { void decideGroup(group, "rejected", rowReason[row.id]); setReasonOpen(new Set([...reasonOpen].filter((x) => x !== row.id))); }}>确认否决</button>
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
                    style={{ maxWidth: 200 }}
                  />
                  <button disabled={busy} onClick={() => void publish(row)}>回填发布</button>
                </>
              )}
            </div>
          </div>
          );
        })}
        </div>
      )}

      <p className="dash-label">⚙ 队列配置<span className="dash-label-sub">手动入口 · AI 参与开关 · 人设</span></p>
      <details className="fold-card review-form-fold">
        <summary><h2 style={{ display: "inline", margin: 0 }}>手动添加选题</h2></summary>
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
      </details>

      <details className="fold-card review-form-fold">
        <summary><h2 style={{ display: "inline", margin: 0 }}>内容簇与多平台大纲</h2></summary>
        <p className="muted">多条同类资讯合并为一个簇；一个簇可产出多份不同平台的大纲，各自独立拍板。AI 自动聚合即将上线，当前支持手动登记。</p>
        <p className="muted">已有簇 {clusters.length} 个{clusters.length ? "：" + clusters.slice(0, 5).map((c) => c.topic + "（" + (c.producedBy || "human") + "）" + (c.coveredVariant ? ` ⚠️已覆盖变体（原选题：${c.coveredVariant.originTitle}，核心词重合 ${Math.round((c.coveredVariant.ratio || 0) * 100)}%）` : "")).join("、") : ""}</p>
        <Field label="簇 ID">
          <Select placeholder="选择内容簇…" value={outlineForm.clusterId || undefined} onChange={(e) => setOutlineForm({ ...outlineForm, clusterId: e.target.value })}>
            {clusters.map((c) => <option key={c.id} value={c.id}>{c.topic}（{c.memberCount} 条）{c.coveredVariant ? " ⚠️已覆盖变体" : ""}</option>)}
          </Select>
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
      </details>

      <details className="fold-card review-form-fold">
        <summary><h2 style={{ display: "inline", margin: 0 }}>内置 AI 参与开关（aiPolicy）</h2></summary>
        <p className="muted">off = 该环节内置 AI 完全不跑、零开销，产出字段留空等外部 Agent（经 /api/v1/agent/clusters、/outlines 写回）或人补。开关是「谁来干」，不是「干不干」。</p>
        {aiPolicy && (
          <div className="toolbar">
            <Field label="初筛 / 打标 / 聚合分类">
              <Select aria-label="triage 档位" value={aiPolicy.triage} onChange={(e) => void saveAiPolicy({ ...aiPolicy, triage: e.target.value })}>
                {["off", "cheap", "full"].map((v) => <option key={v} value={v}>{v}</option>)}
              </Select>
            </Field>
            <Field label="多平台大纲生成">
              <Select aria-label="outline 档位" value={aiPolicy.outline} onChange={(e) => void saveAiPolicy({ ...aiPolicy, outline: e.target.value })}>
                {["off", "cheap", "full"].map((v) => <option key={v} value={v}>{v}</option>)}
              </Select>
            </Field>
            <Field label="草稿正文">
              <Select aria-label="draft 档位" value={aiPolicy.draft} onChange={(e) => void saveAiPolicy({ ...aiPolicy, draft: e.target.value })}>
                {["off", "cheap", "full"].map((v) => <option key={v} value={v}>{v}</option>)}
              </Select>
            </Field>
            <Field label="写作方">
              <Select aria-label="aiWriter 档位" value={aiPolicy.aiWriter} onChange={(e) => void saveAiPolicy({ ...aiPolicy, aiWriter: e.target.value })}>
                {["off", "cheap", "full"].map((v) => <option key={v} value={v}>{v}</option>)}
              </Select>
            </Field>
          </div>
        )}
      </details>

      <details className="fold-card review-form-fold">
        <summary><h2 style={{ display: "inline", margin: 0 }}>人设配置（AI 个性化判断输入）</h2></summary>
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
      </details>
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
          onPlatformDecide={async (platform, decision) => {
            await act(async () => {
              // functional 更新：act 后的 rows 闭包是旧渲染，直接用服务端响应改 detail
              const res = await api<{ perPlatformDecision: Record<string, string>; decision: string }>(`outlines/${detail.id}/platform-decision`, { platform, decision });
              setDetail((d: typeof detail | null) => (d && d.id === detail.id ? { ...d, perPlatformDecision: res.perPlatformDecision, decision: res.decision } : d));
            });
          }}
          onCategory={async (category) => {
            await act(async () => {
              const res = await api<{ category: string }>(`outlines/${detail.id}/category`, { category });
              setDetail((d: typeof detail | null) => (d && d.id === detail.id ? { ...d, category: res.category } : d));
            });
          }}
        />
      )}
    </div>
  );
}
