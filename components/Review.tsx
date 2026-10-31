"use client";
import { useEffect, useMemo, useState } from "react";
import { api, Field, formatApiError, date } from "./ui";
import { OutlineDrawer } from "./views/OutlineQueueView";
import { PLATFORM_KEYS, PLATFORM_LABELS, platformLabel, aggregateOutlineDecision } from "../core/platforms";
import { MessageContent } from "./MessageContent";
import { Select } from "./Select";
import { creationLabels } from "../core/workspace-ui";
import { useListKeyboardShortcuts } from "./useListKeyboardShortcuts";

// 审查台（决策层 UI）：队列视图 + 多选批量拍板 + 手动添加选题 + 成稿回填 + 簇/大纲 + 人设配置。
// 语义红线：quality 是证据可信度（AI 判），decision 是要不要写（人拍板）——两层不互相推导。
type Row = {
  sourceType: string; id: string; kind: string; title: string; summary?: string; quality?: string;
  decision: string; platform?: string; platforms?: string[]; recommendation?: string; category?: string; perPlatformDecision?: Record<string, string>; outline?: string[]; rejectReason?: string; publishedRef?: string;
  suggestions?: { by: string; verdict: string; score?: number; reason?: string }[];
  producedBy?: string;
  draftBody?: string;
  creationStatus?: string;
  createdAt: string; evidenceCount?: number; clusterId?: string;
};
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
const sourceFilterLabels: Record<string, string> = { outline: "大纲", manual: "手动" };
const c2n = (n: number) => String(n);
// R10.37 C②：状态快捷卡的组合过滤口径——「进行中」=drafting+published、「已否决·暂缓」=rejected+deferred
//（单状态值来自工具行按钮，不在表内按原值过滤）。
const STATUS_CARD_FILTERS: Record<string, string[]> = {
  pending: ["pending"], approved: ["approved"], active: ["drafting", "published"], closed: ["rejected", "deferred"],
};

// R10.35：一条选题的「适合平台」= 组内各行的 platforms 并集（主行优先保序）。
// 单行新数据带 platforms；老数据没有 platforms，退回该行自己的 platform——
// 这样存量 166 条多平台行聚合后，平台徽章集合与改造前完全等价，不会少平台。
function groupPlatforms(primary: Row, members: Row[]): string[] {
  const out: string[] = [];
  const push = (raw?: string) => {
    if (!raw) return;
    const key = PLATFORM_KEYS.find((k) => k === raw || PLATFORM_LABELS[k] === raw);
    if (key && !out.includes(key)) out.push(key);
  };
  for (const p of primary.platforms || []) push(p);
  push(primary.platform);
  for (const m of members) {
    for (const p of m.platforms || []) push(p);
    push(m.platform);
  }
  return out;
}

export function Review() {
  const [rows, setRows] = useState<Row[]>([]);
  const [detail, setDetail] = useState<any>(null);
  const [status, setStatus] = useState<string>("pending");
  const [sourceFilter, setSourceFilter] = useState("all");
  // R10.43①②：大按钮范围确认——平台数≥2 时先问「全部/仅主平台」；默认项随否决原因语义分家
  // （内容级原因 no-ai-signal/写不透/已写过=只废主平台的内容角度；平台级 off-domain/不感兴趣=全平台）。
  const [scopeConfirm, setScopeConfirm] = useState<{ decision: string; reason?: string; platforms: string[]; primaryPlatform: string; rowIds: string[] } | null>(null);
  // R10.43④：平台级批量——勾选行 × 选定平台的 platform-decision 批量写
  const [batchPlatform, setBatchPlatform] = useState("");
  // R10.42④：平台多选筛选（与状态/来源正交叠加）——勾选的 platform 键集合，
  // 行的适合平台（platforms ∪ platform）命中任一即显示。空集=不限。
  const [platformFilter, setPlatformFilter] = useState<Set<string>>(new Set());
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
  const [consumerMode, setConsumerMode] = useState("external");
  // R10.35：一个选题一条大纲——platforms 逗号分隔（适合平台），recommendation 为推荐建议
  const [outlineForm, setOutlineForm] = useState({ clusterId: "", platforms: "gzh", contentType: "长文", title: "", recommendation: "" });
  const [clusters, setClusters] = useState<any[]>([]);
  // R10 第4段：今日总览（四段流水线一屏看全）+ 外部消费回执（超 24h 未跑提醒）
  const [today, setToday] = useState<any>(null);
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
    setToday(await api<any>("summary/today").catch(() => null)); // P1-2：拍板后总览随 reload 刷新
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
        setConsumerMode(await api<any>("consumerMode").catch(() => "external"));
        setToday(await api<any>("summary/today").catch(() => null));
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
  const platformOfRow = (r: Row): string[] => [...new Set([...(r.platforms || []), r.platform].filter((x): x is string => !!x))]
  .map((p) => PLATFORM_KEYS.find((k) => k === p || PLATFORM_LABELS[k] === p) ?? p); // 未归一值原样返回（匹配不上筛选集，无害）
const visible = rows.filter((r) => { if (status === "all") return true; const f = STATUS_CARD_FILTERS[status]; return f ? f.includes(r.decision) : r.decision === status; })
  .filter((r) => sourceFilter === "all" || r.sourceType === sourceFilter)
  .filter((r) => !platformFilter.size || platformOfRow(r).some((p) => platformFilter.has(p)));
  // 数据治理（根因 B + R10.35）：同选题聚合。
  // R10.35 前大纲按平台拆行（一簇 4 行、标题各不同），按 title 聚合只能聚 2/48 簇；
  // 现改按「选题身份」聚合——outline 用 clusterId（一簇=一个事件/选题方向），
  // 其他来源（manual/artifact）无 clusterId 退回 title。组内取最新为主行，拍板=按平台批量。
  const groups = useMemo(() => {
    const byKey = new Map<string, Row[]>();
    for (const r of visible) {
      const key = r.sourceType === "outline" && r.clusterId ? "clu:" + r.clusterId : "title:" + r.title.trim();
      const bucket = byKey.get(key) || [];
      bucket.push(r);
      byKey.set(key, bucket);
    }
    return [...byKey.entries()]
      .map(([key, members]) => {
        const sorted = [...members].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
        return { key, primary: sorted[0], members: sorted };
      })
      .sort((a, b) => b.primary.createdAt.localeCompare(a.primary.createdAt));
  }, [visible]);
  const expandedGroups = useState<Set<string>>(new Set());
  const [openGroups, setOpenGroups] = expandedGroups;
  // R10.37 C⑤：键盘流（J/K 移动、A 通过、X 否决、D 详情）——与队列视图同款，主战场补齐
  useListKeyboardShortcuts(".decision-row", {
    approve: () => { if (groups[0]) void decideGroup(groups[0], "approved"); },
    archive: () => { if (groups[0]) void decideGroup(groups[0], "rejected", "其他"); },
    discuss: () => { if (groups[0]) setDetail(groups[0].primary); },
  }, groups.length > 0);
  const toggleGroup = (key: string) => setOpenGroups((prev) => {
    const next = new Set(prev);
    if (next.has(key)) next.delete(key); else next.add(key);
    return next;
  });
  // 同题×N 不再连拍（第六轮批 B §2① + R10.37 A-1）：组拍板=对选题的「适合平台并集」
  // 逐平台拍（与徽章渲染 groupPlatforms 同源）——R10.35 一选题一条后，单行多平台的
  // 全部适合平台一起拍，不再只拍主平台；旧多行簇（克隆行）的各平台经并集自然覆盖。
  async function applyGroupScope(decision: string, platforms: string[], scope: "all" | "primary", rowId: string) {
    await act(async () => {
      const targets = scope === "all" ? platforms : platforms.slice(0, 1);
      for (const key of targets) {
        await api(`outlines/${rowId}/platform-decision`, { platform: key, decision });
      }
      await reload();
      setNotice(scope === "all"
        ? `已按平台拍板 ${targets.length} 个平台（${decision}）——各平台状态独立，可点平台徽章分别改。`
        : `已仅拍主平台（${targets[0]}，${decision}）——其余平台保持待决策。`);
    });
  }
  const CONTENT_REASONS = ["no-ai-signal", "写不透", "已写过"];
  async function decideGroup(group: { primary: Row; members: Row[] }, decision: string, reason?: string) {
    if (group.primary.sourceType !== "outline") return decide(group.primary, decision, reason);
    const platforms = groupPlatforms(group.primary, group.members);
    if (!platforms.length) return decide(group.primary, decision, reason);
    // R10.43①②：平台数≥2 → 范围确认框（默认随原因语义分家）；=1 直拍
    if (platforms.length >= 2) {
      setScopeConfirm({ decision, reason, platforms, primaryPlatform: platforms[0], rowIds: [group.primary.id] });
      return;
    }
    return applyGroupScope(decision, platforms, "all", group.primary.id);
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
      // R10.43④：选了平台 → 平台级批量（对勾选中 platforms 含该平台的行写 per-platform）；
      // 未选 → 行级批量（原语义）。
      if (batchPlatform) {
        const rowsById = new Map(rows.map((r) => [r.id, r]));
        let applied = 0;
        for (const id of selected) {
          const r = rowsById.get(id);
          if (!r || r.sourceType !== "outline") continue;
          const keys = platformOfRow(r);
          if (!keys.includes(batchPlatform)) continue;
          await api(`outlines/${id}/platform-decision`, { platform: batchPlatform, decision });
          applied++;
        }
        await reload();
        setSelected(new Set());
        setNotice(`已批量拍板 ${applied} 条的 ${PLATFORM_LABELS[batchPlatform] || batchPlatform} 平台（${decision}）——行级状态随聚合更新。`);
        return;
      }
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
  // R10.43⑤：已拍行快速改判——rejected/deferred 行内「翻回待定」（outlines 走行级翻转端点）
  async function flipRow(row: Row) {
    await act(async () => {
      const path = row.sourceType === "outline" ? `outlines/${row.id}/decision` : row.sourceType === "artifact" ? `artifacts/${row.id}/decision` : `decisions/${row.id}/decision`;
      await api(path, { decision: "pending" });
      await reload();
      setNotice("已翻回待决策。");
    });
  }
  // R10.43③：approved 行内「开始写作」——直接进详情草稿区
  function startWriting(row: Row) {
    setDetail(row);
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
      setNotice("内置 AI 参与开关已保存：triage=" + saved.triage + "，draft=" + saved.draft + "。off 的环节产出可为空，由外部 Agent 或人补。");
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
    const platforms = outlineForm.platforms.split(/[,，\s]+/).map((x) => x.trim()).filter(Boolean);
    if (!platforms.length) return setNotice("至少填一个适合平台。");
    await act(async () => {
      await api("outlines", {
        clusterId: outlineForm.clusterId,
        platforms,
        contentType: outlineForm.contentType,
        title: outlineForm.title.trim(),
        ...(outlineForm.recommendation.trim() ? { recommendation: outlineForm.recommendation.trim() } : {}),
      });
      await reload();
      setNotice("大纲已创建，进入待决策队列。");
    });
  }

  // R10.37 C②：快捷卡的计数与过滤口径对齐——「进行中」=drafting+published、「已否决·暂缓」
  // =rejected+deferred 都按组合过滤（旧实现卡上数字含两态、点进去只过滤一态，数字对不上）。
  const statusCards: Array<{ key: string; label: string; count: number; accent: boolean; states: string[]; small: string }> = [
    { key: "pending", label: "待决策", count: stats.pending || 0, accent: true, states: ["pending"], small: "点卡片只看这一档，再点回全部" },
    { key: "approved", label: "已通过", count: stats.approved || 0, accent: false, states: ["approved"], small: "进入写作与发布流转" },
    { key: "active", label: "进行中", count: (stats.drafting || 0) + (stats.published || 0), accent: false, states: ["drafting", "published"], small: `写作中 ${stats.drafting || 0} · 已发布 ${stats.published || 0} 条` },
    { key: "closed", label: "已否决·暂缓", count: (stats.rejected || 0) + (stats.deferred || 0), accent: false, states: ["rejected", "deferred"], small: `已否决 ${stats.rejected || 0} · 暂缓 ${stats.deferred || 0}` },
  ];
  return (
    <div>
      {error && <p role="alert" className="error">{error}</p>}
      {notice && <p role="status" className="notice">{notice}</p>}
      {scopeConfirm && (
        <div role="dialog" aria-modal aria-label="拍板范围确认" style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,.35)", display: "grid", placeItems: "center", zIndex: 60 }} onClick={() => setScopeConfirm(null)}>
          <div className="surface" style={{ maxWidth: 420, width: "92%", padding: 20 }} onClick={(e) => e.stopPropagation()}>
            <h3 style={{ margin: "0 0 6px", fontSize: 16 }}>拍板范围确认（{scopeConfirm.decision === "approved" ? "通过" : scopeConfirm.decision === "rejected" ? "否决" : "暂缓"}）</h3>
            <p className="muted" style={{ margin: "0 0 12px", fontSize: 13 }}>
              该选题标注了 {scopeConfirm.platforms.length} 个适合平台（{scopeConfirm.platforms.map((k) => PLATFORM_LABELS[k] || k).join(" / ")}）。
              {scopeConfirm.reason && ["off-domain", "不感兴趣", "其他"].includes(scopeConfirm.reason) ? "平台级原因（如域外/不感兴趣）通常适用于全部平台。" : "内容级原因（写不透/已写过/无信号）通常只影响主平台的内容角度。"}
            </p>
            <div style={{ display: "grid", gap: 8 }}>
              <button className="primary" style={{ minHeight: 36 }} onClick={() => { const c = scopeConfirm; setScopeConfirm(null); void applyGroupScope(c.decision, c.platforms, "all", c.rowIds[0]); }}>
                应用到全部 {scopeConfirm.platforms.length} 个平台{scopeConfirm.reason && ["off-domain", "不感兴趣", "其他"].includes(scopeConfirm.reason) ? "（推荐）" : ""}
              </button>
              <button className="button-secondary" style={{ minHeight: 36 }} onClick={() => { const c = scopeConfirm; setScopeConfirm(null); void applyGroupScope(c.decision, c.platforms, "primary", c.rowIds[0]); }}>
                仅主平台 {PLATFORM_LABELS[scopeConfirm.primaryPlatform] || scopeConfirm.primaryPlatform}{scopeConfirm.reason && ["no-ai-signal", "写不透", "已写过"].includes(scopeConfirm.reason) ? "（推荐）" : ""}
              </button>
              <button style={{ minHeight: 32 }} onClick={() => setScopeConfirm(null)}>取消</button>
            </div>
          </div>
        </div>
      )}

      {/* ⓪ 今日总览（R10.8 P1-2 六段）：采集→精简→组→待拍→已拍→机会卡→外部回执 */}
      {today && (
        <div className="stat-strip" style={{ marginBottom: 8 }} aria-label="今日总览">
          <div className="stat-card"><strong>{today.collectAll?.raw ?? "—"}</strong><span>采集（{today.collectAll?.sources ?? "—"} 源）</span></div>
          <div className="stat-card"><strong>{today.inPool ?? "—"}</strong><span>入池</span></div>
          <div className="stat-card accent"><strong>{today.groups ? today.groups.strong + today.groups.potential : "—"}</strong><span>组（强 {today.groups?.strong ?? 0} / 潜 {today.groups?.potential ?? 0} / 无 {today.groups?.none ?? 0}）</span></div>
          <div className="stat-card"><strong>{(today.pendingOutlines ?? 0) + (today.pendingDecisions ?? 0)}</strong><span>待拍（大纲 {today.pendingOutlines ?? 0} · 决策 {today.pendingDecisions ?? 0}）</span></div>
          <div className="stat-card"><strong>{today.decidedToday ?? 0}</strong><span>今日已拍</span></div>
          <div className="stat-card"><strong>{today.opportunities ?? 0}</strong><span>机会卡</span></div>
          <button className="stat-card clickable" onClick={() => window.location.hash = "ideas"}>
            <strong>{today.todayChecks?.total ?? 0}</strong><span>今日待查词（哥飞手动）↗</span>
          </button>
          <div className={"stat-card" + (today.externalConsumption?.stale ? " accent" : "")}>
            <strong>{today.externalConsumption ? today.externalConsumption.consumed : "—"}</strong>
            <span>外部消费{today.externalConsumption ? `（${String(today.externalConsumption.by || "").replace("agent:", "")}）` : "（无回执）"}</span>
            {today.externalConsumption?.stale && <small>⚠️ 超 24h 未跑——检查外部 Agent 调度</small>}
            {!today.externalConsumption && <small>接上：外部 Agent 跑完 ping POST /api/v1/agent/consume-report（consume 令牌，body {"{"}consumed:N{"}"}），见外部接入页</small>}
          </div>
        </div>
      )}

      {/* ① 统计条（点击切状态档） */}
      <div className="stat-strip">
        {statusCards.map((c) => (
          <button type="button" key={c.key} className={"stat-card clickable" + (c.accent ? " accent" : "") + (status === c.key ? " active" : "")}
            aria-pressed={status === c.key}
            onClick={() => setStatus(status === c.key ? "all" : c.key)}>
            <strong>{c.count}</strong><span>{c.label}</span>
            <small>{c.small}</small>
          </button>
        ))}
      </div>

      {/* ② 工具行：状态/来源筛选 + 批量 + 规则 */}
      <div className="radar-toolbar">
        {/* R10.42①②：nav 与快捷卡同一键空间（全部+四组合键）——点卡 nav 亮、点 nav 卡亮，
            pending 不再只有卡入口（旧 nav 排除 pending 造成两套路径）。数字与卡完全一致。 */}
        <nav className="discovery-modes" aria-label="决策状态筛选">
          <button className={status === "all" ? "active" : ""} onClick={() => setStatus("all")}>全部 {rows.length}</button>
          {statusCards.map((c) => (
            <button key={c.key} className={status === c.key ? "active" : ""} aria-pressed={status === c.key}
              onClick={() => setStatus(status === c.key ? "all" : c.key)}>{c.label} {c.count}</button>
          ))}
        </nav>
        <details className="filters-popover" data-popover>
          <summary className="button" aria-label="筛选与批量操作" style={{ marginLeft: "auto" }}>来源与批量（已选 {selected.size}{platformFilter.size ? ` · 平台 ${platformFilter.size}` : ""}）</summary>
          <div className="popover-panel">
            <Field label="来源筛选">
              <Select aria-label="来源筛选" value={sourceFilter} onChange={(e) => setSourceFilter(e.target.value)}>
                <option value="all">全部来源</option>
                <option value="outline">大纲</option>
                <option value="manual">手动</option>
              </Select>
            </Field>
            <Field label={platformFilter.size ? `平台筛选（已选 ${platformFilter.size}）` : "平台筛选（适合平台含任一勾选）"}>
              <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }} role="group" aria-label="平台多选筛选">
                {PLATFORM_KEYS.filter((k) => rows.some((r) => platformOfRow(r).includes(k))).map((k) => (
                  <button key={k} type="button" className={platformFilter.has(k) ? "pill" : "button-secondary"}
                    style={{ cursor: "pointer", padding: "4px 10px", fontSize: 12 }}
                    aria-pressed={platformFilter.has(k)}
                    onClick={() => setPlatformFilter((prev) => { const n = new Set(prev); if (n.has(k)) n.delete(k); else n.add(k); return n; })}>
                    {PLATFORM_LABELS[k]}{platformFilter.has(k) ? " ✓" : ""}
                  </button>
                ))}
                {platformFilter.size > 0 && (
                  <button type="button" className="button-secondary" style={{ padding: "4px 10px", fontSize: 12 }} onClick={() => setPlatformFilter(new Set())}>清除</button>
                )}
              </div>
            </Field>
            <Field label="批量否决原因">
              <Select aria-label="批量否决原因" value={batchReason} onChange={(e) => setBatchReason(e.target.value)}>
                {rejectReasons.map((r) => <option key={r} value={r}>{r}</option>)}
              </Select>
            </Field>
            <Field label={batchPlatform ? "批量范围：仅该平台（R10.43④）" : "批量范围：行级（选平台改按平台拍）"}>
              <Select aria-label="批量平台选择" value={batchPlatform} onChange={(e) => setBatchPlatform(e.target.value)}>
                <option value="">不限（行级拍板）</option>
                {PLATFORM_KEYS.filter((k) => rows.some((r) => platformOfRow(r).includes(k))).map((k) => (
                  <option key={k} value={k}>{PLATFORM_LABELS[k]}</option>
                ))}
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
                  <button className="creation-badge" style={{ cursor: "pointer" }} onClick={() => toggleGroup(group.key)}>同题 ×{dupCount}{openGroups.has(group.key) ? " ▲" : " ▼"}</button>
                )}
                {row.quality && <span className="creation-badge">可信度 {qualityLabels[row.quality] || row.quality}</span>}
                {row.draftBody && <span className="creation-badge" style={{ color: "#1a7f4b" }}>有草稿</span>}
                {row.rejectReason && <span className="creation-badge">否决：{row.rejectReason}</span>}
              </div>
              {row.sourceType === "outline" && groupPlatforms(row, group.members).length > 0 && (
                <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginTop: 4, alignItems: "center" }} aria-label="适合平台与按平台拍板">
                  <span className="muted" style={{ fontSize: 11 }} title="这条选题适合投放的平台；点徽章=单独拍板该平台（循环状态），其余平台不受影响">适合 · 点徽章单拍</span>
                  {groupPlatforms(row, group.members).map((k) => {
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
              {row.recommendation && (
                <p className="decision-summary" style={{ marginTop: 6 }}>
                  <span className="muted" style={{ fontSize: 11 }}>推荐 · </span>{row.recommendation}
                </p>
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
              {dupCount > 1 && openGroups.has(group.key) && (
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
              {row.decision === "approved" && row.sourceType === "outline" && (
                <button className="button-secondary" disabled={busy} onClick={() => startWriting(row)}>开始写作</button>
              )}
              {(row.decision === "rejected" || row.decision === "deferred") && (
                <button className="button-secondary" disabled={busy} onClick={() => void flipRow(row)}>翻回待定</button>
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
        <summary><h2 style={{ display: "inline", margin: 0 }}>内容簇与选题大纲</h2></summary>
        <p className="muted">多条同类资讯合并为一个簇。R10.35 起一个选题只写一条大纲：写清「讲什么、怎么讲」，用「适合平台」标注投放到哪几个平台，平台差异写进「推荐建议」。</p>
        <p className="muted">已有簇 {clusters.length} 个{clusters.length ? "：" + clusters.slice(0, 5).map((c) => c.topic + "（" + (c.producedBy || "human") + "）" + (c.coveredVariant ? ` ⚠️已覆盖变体（原选题：${c.coveredVariant.originTitle}，核心词重合 ${Math.round((c.coveredVariant.ratio || 0) * 100)}%）` : "")).join("、") : ""}</p>
        <Field label="簇 ID">
          <Select placeholder="选择内容簇…" value={outlineForm.clusterId || undefined} onChange={(e) => setOutlineForm({ ...outlineForm, clusterId: e.target.value })}>
            {clusters.map((c) => <option key={c.id} value={c.id}>{c.topic}（{c.memberCount} 条{c.outlineCount ? ` · 已有大纲 ${c.outlineCount}` : ""}）{c.coveredVariant ? " ⚠️已覆盖变体" : ""}</option>)}
          </Select>
        </Field>
        {clusters.find((c) => c.id === outlineForm.clusterId)?.outlineCount ? (
          <p className="muted" style={{ margin: 0 }}>该簇已有大纲——一簇=一选题，通常应更新既有大纲（Agent 口同簇新建会被 duplicate 拦下）；此处继续创建会形成同题组。</p>
        ) : null}
        <Field label="适合平台（逗号分隔，如 gzh,xhs-note）">
          <input value={outlineForm.platforms} onChange={(e) => setOutlineForm({ ...outlineForm, platforms: e.target.value })} />
        </Field>
        <Field label="推荐建议（可选：为什么这么写、各平台怎么适配）">
          <textarea rows={3} value={outlineForm.recommendation} onChange={(e) => setOutlineForm({ ...outlineForm, recommendation: e.target.value })} />
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
        <summary><h2 style={{ display: "inline", margin: 0 }}>内置 AI 参与开关（aiPolicy）</h2>{consumerMode !== "builtin" && <span className="pill" style={{ marginLeft: 8 }} title="consumerMode=builtin 时这些开关才生效">builtin 专属 · 只读</span>}</summary>
        <p className="muted">{consumerMode === "builtin"
          ? "off = 该环节内置 AI 完全不跑、零开销，产出字段留空等外部 Agent（经 /api/v1/agent/clusters、/outlines 写回）或人补。开关是「谁来干」，不是「干不干」。triage = 采集批次的语义初筛（R9-6：AI 归类 + 注意力判级 + 双线草案，名额按组分配），off 时回退来源均衡分配；draft = 已批大纲的主平台出稿。R10.36（方案 B 降级声明）：builtin 不产适合平台集合与推荐建议的语义标注——大纲由你在上方表单手动创建（支持多平台+推荐建议）或外部 Agent 写回，内置 AI 只按主平台出稿；完整选题形态走 external。"
          : "当前 consumerMode=external：开关不参与任何执行链，仅作 builtin 切换时的预设值保留（只读）。语义初筛与选题大纲（一选题一条：适合平台+推荐建议）由外部 Agent 02:00 全套执行。"}</p>
        {aiPolicy && (
          <div className="toolbar">
            <Field label="语义初筛（归类+判级）">
              <Select aria-label="triage 档位" disabled={consumerMode !== "builtin"} value={aiPolicy.triage} onChange={(e) => void saveAiPolicy({ ...aiPolicy, triage: e.target.value })}>
                {["off", "cheap", "full"].map((v) => <option key={v} value={v}>{v}</option>)}
              </Select>
            </Field>
            <Field label="已批大纲主平台出稿">
              <Select aria-label="draft 档位" disabled={consumerMode !== "builtin"} value={aiPolicy.draft} onChange={(e) => void saveAiPolicy({ ...aiPolicy, draft: e.target.value })}>
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
