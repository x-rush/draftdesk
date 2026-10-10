"use client";

import { useEffect, useState } from "react";
import { activityPlatforms, activityPageSchema, isActivityIndexUrl } from "../core/activity-import";
import {
  activityBatchSchema,
  activityBatchDecision,
  activityBatchLead,
  activityBatchMatches,
  activityMaterialStatus,
  manualActivityDeadline,
  type ActivityBatchItem,
} from "../core/activity-batch";
import type { ActivityTriageRecord } from "../core/activity-triage";
import { api, Drawer, Field } from "./ui";

type ActivityView = "recommend" | "materials" | "history";
type ReceivedRow = { id: string; receivedAt: string; platform: string; count: number; hasCoverage: boolean };

const formatDate = (value: string) => {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString("zh-CN");
};

export function ActivityImport({ onChange, onRun, active }: { onChange: () => Promise<void>; onRun: () => void; active: boolean }) {
  const [platform, setPlatform] = useState(0);
  const [title, setTitle] = useState("");
  const [url, setUrl] = useState("");
  const [text, setText] = useState("");
  const [deadlineDate, setDeadlineDate] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [evidenceId, setEvidenceId] = useState("");
  const [batch, setBatch] = useState<ActivityBatchItem[]>([]);
  const [batchWarnings, setBatchWarnings] = useState<string[]>([]);
  const [batchIds, setBatchIds] = useState<string[]>([]);
  const [batchCoverage, setBatchCoverage] = useState<Array<{ platform: string; summary: string; short: string }>>([]);
  const [hasBatch, setHasBatch] = useState(false);
  const [selectedLead, setSelectedLead] = useState("");
  const [keywordText, setKeywordText] = useState("AI, AIGC, AI视频, Vibe Coding, vibecoding, AI编程, AI工具");
  const [batchSource, setBatchSource] = useState<"plugin" | "file" | "archive">("plugin");
  const [received, setReceived] = useState<ReceivedRow[]>([]);
  const [triage, setTriage] = useState<ActivityTriageRecord | null>(null);
  const [triageHistory, setTriageHistory] = useState<Array<{ id: string; createdAt: string; selectedCount: number }>>([]);
  const [activeView, setActiveView] = useState<ActivityView>("recommend");
  const [platformFilter, setPlatformFilter] = useState("全部");
  const [statusFilter, setStatusFilter] = useState<"all" | "live" | "expired" | "unknown">("all");
  const [matchFilter, setMatchFilter] = useState<"all" | "matched" | "unmatched">("all");
  const [rawQuery, setRawQuery] = useState("");
  const [drawer, setDrawer] = useState<"detail" | "verify" | null>(null);
  const [selectedItem, setSelectedItem] = useState<ActivityBatchItem | null>(null);
  const [showSetup, setShowSetup] = useState(true);
  const [lastReceivedSignature, setLastReceivedSignature] = useState("");
  const [lastTriageId, setLastTriageId] = useState("");

  const keywords = keywordText.split(/[,，\n]/).map((x) => x.trim()).filter(Boolean);
  const eligible = batch.filter((item) => activityBatchDecision(item, keywords).eligible);
  const relevantLeads = batch.filter((item) => activityBatchLead(item, keywords) && !activityBatchDecision(item, keywords).eligible);
  const priority = [...eligible, ...relevantLeads];
  const latestReceived = received.filter((row, index, rows) => rows.findIndex((other) => other.platform === row.platform) === index).slice(0, 4);
  const triageMatchesCurrentBatch = Boolean(
    triage && batchIds.length > 0 && triage.batchIds.length === batchIds.length && triage.batchIds.every((id) => batchIds.includes(id)),
  );
  const formalReason = eligible.length === 0
    ? "没有同时满足关键词、未过期、截止年份明确和规则正文完整的活动"
    : eligible.length > 24
      ? "合格活动超过单次研究的 24 条上限"
      : active
        ? "已有活动研究正在运行"
        : "已核实活动可以进入正式分析";
  const statusRank = { live: 0, unknown: 1, expired: 2 } as const;
  const statusLabel = { live: "进行中", expired: "已过期", unknown: "日期不明" } as const;
  const query = rawQuery.trim().toLocaleLowerCase();
  const materialPass = (item: ActivityBatchItem, except?: "platform" | "status" | "match") => {
    if (except !== "platform" && platformFilter !== "全部" && item.platform !== platformFilter) return false;
    if (except !== "status" && statusFilter !== "all" && activityMaterialStatus(item) !== statusFilter) return false;
    if (except !== "match") {
      const matched = activityBatchMatches(item, keywords);
      if (matchFilter === "matched" && !matched) return false;
      if (matchFilter === "unmatched" && matched) return false;
    }
    return !query || `${item.title} ${item.text}`.toLocaleLowerCase().includes(query);
  };
  const sortMaterials = (items: ActivityBatchItem[]) => [...items].sort((a, b) => {
    const rank = statusRank[activityMaterialStatus(a)] - statusRank[activityMaterialStatus(b)];
    return rank || b.capturedAt.localeCompare(a.capturedAt);
  });
  const filteredMaterials = sortMaterials(batch.filter((item) => materialPass(item)));
  const platformsInBatch = [...new Set(batch.map((item) => item.platform))];
  const countBy = <T extends string>(key: (item: ActivityBatchItem) => T, except: "platform" | "status" | "match") => {
    const counts = new Map<T, number>();
    batch.filter((item) => materialPass(item, except)).forEach((item) => counts.set(key(item), (counts.get(key(item)) || 0) + 1));
    return counts;
  };
  const platformCounts = countBy((item) => item.platform as string, "platform");
  const statusCounts = countBy((item) => activityMaterialStatus(item), "status");
  const matchCount = (want: "matched" | "unmatched") => batch.filter((item) => materialPass(item, "match") && (want === "matched") === activityBatchMatches(item, keywords)).length;
  const clearMaterialFilters = () => { setPlatformFilter("全部"); setStatusFilter("all"); setMatchFilter("all"); setRawQuery(""); };

  const reset = () => setEvidenceId("");

  function applyBundles(raw: unknown[], ids: string[]) {
    const data = raw.map((item) => activityBatchSchema.parse(item));
    if (data.some((item) => !item.coverage)) throw new Error("检测到旧版采集包。旧版内容不再导入，请从官方活动页重新采集当前版本。");
    const seen = new Set<string>();
    const items = data.flatMap((item) => item.items).filter((item) => {
      const key = `${item.platform}|${item.url}|${item.title}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
    setBatch(items);
    setBatchIds(ids);
    setBatchWarnings(data.flatMap((item) => item.warnings.map((warning) => `${item.platform}：${warning}`)));
    setBatchCoverage(data.map((item) => {
      const coverage = item.coverage!;
      const scopeShort = coverage.scope === "current_month" ? "月" : coverage.scope === "screens" ? "屏" : "页";
      return {
        platform: item.platform,
        short: `${scopeShort}${coverage.scannedPages}/${coverage.requestedPages}${coverage.visibleTotal !== null ? ` · 平台共 ${coverage.visibleTotal} 条` : ""}`,
        summary: `${coverage.scope === "current_month" ? "当前月份" : coverage.scope === "screens" ? "页面屏数" : "列表页"} ${coverage.scannedPages}/${coverage.requestedPages}；${coverage.visibleTotal === null ? "总量未知" : `列表显示 ${coverage.visibleTotal} 条`}；${coverage.note}`,
      };
    }));
    setHasBatch(true);
    setSelectedLead("");
    const words = [...new Set(data.flatMap((item) => item.keywords))];
    if (words.length) setKeywordText(words.join(", "));
  }

  function openVerify(item?: ActivityBatchItem) {
    if (item) {
      setSelectedItem(item);
      setTitle(item.title);
      setUrl(item.url);
      setText(item.text);
      setDeadlineDate("");
      setSelectedLead(`${item.platform} · ${item.title}`);
    } else {
      setSelectedItem(null);
      setTitle("");
      setUrl("");
      setText("");
      setDeadlineDate("");
      setSelectedLead("");
    }
    reset();
    setDrawer("verify");
  }

  function inspectItem(item: ActivityBatchItem) {
    setSelectedItem(item);
    setDrawer("detail");
  }

  useEffect(() => {
    let cancelled = false;
    async function refresh() {
      try {
        const [rows, history] = await Promise.all([
          api<ReceivedRow[]>("activity-batches"),
          api<Array<{ id: string; createdAt: string; selectedCount: number; batchIds?: string[] }>>("activity-triage"),
        ]);
        if (cancelled) return;
        const currentRows = rows.filter((row) => row.hasCoverage);
        const currentIds = new Set(currentRows.map((row) => row.id));
        const currentHistory = history.filter((row) => row.batchIds?.length && row.batchIds.every((id) => currentIds.has(id)));
        setReceived(currentRows);
        setTriageHistory(currentHistory);
        if (currentHistory[0]?.id && currentHistory[0].id !== lastTriageId) {
          const latest = await api<ActivityTriageRecord>(`activity-triage/${currentHistory[0].id}`);
          if (!cancelled) {
            setTriage(latest);
            setLastTriageId(latest.id);
          }
        } else if (!currentHistory.length) {
          setTriage(null);
          setLastTriageId("");
        }
        if (batchSource !== "plugin") return;
        const seen = new Set<string>();
        const latest = currentRows.filter((row) => {
          if (seen.has(row.platform)) return false;
          seen.add(row.platform);
          return true;
        }).slice(0, 4);
        const signature = latest.map((row) => row.id).join("|");
        if (!signature || signature === lastReceivedSignature) return;
        const records = await Promise.all(latest.map((row) => api<{ bundle: unknown }>(`activity-batches/${row.id}`)));
        if (cancelled) return;
        applyBundles(records.map((record) => record.bundle), latest.map((row) => row.id));
        setLastReceivedSignature(signature);
        setError("");
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? `读取活动档案失败：${e.message}` : "读取活动档案失败");
      }
    }
    void refresh();
    const timer = setInterval(() => void refresh(), 5000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [batchSource, lastReceivedSignature, lastTriageId]);

  async function load(files?: FileList) {
    if (!files?.length) return;
    try {
      if (files.length > 4) throw new Error("最多同时导入四个平台的四份文件。");
      const raw = await Promise.all([...files].map(async (file) => {
        if (file.size > 5000000) throw new Error("单个文件超过 5MB。请缩小采集范围。");
        return JSON.parse((await file.text()).replace(/^\uFEFF/, ""));
      }));
      if (raw.every((item) => item.schemaVersion === "draftdesk.activity-batch.v1")) {
        const data = raw.map((item) => activityBatchSchema.parse(item));
        if (data.some((item) => !item.coverage)) throw new Error("检测到旧版采集包。旧版内容不再导入，请从官方活动页重新采集当前版本。");
        const saved = await Promise.all(data.map((bundle) => api<{ id: string }>("activity-batches", bundle)));
        applyBundles(data, saved.map((item) => item.id));
        setBatchSource("file");
      } else if (raw.length === 1) {
        const data = activityPageSchema.parse(raw[0]);
        setBatch([]);
        setBatchWarnings([]);
        setBatchIds([]);
        setHasBatch(false);
        setBatchSource("file");
        setTitle(data.title);
        setUrl(data.url);
        setText(data.text);
        setDeadlineDate("");
        reset();
        setSelectedItem(null);
        setSelectedLead("");
        setDrawer("verify");
      } else {
        throw new Error("多文件导入只支持批量活动包。");
      }
      setError("");
    } catch (e) {
      setError(e instanceof Error ? `导入失败：${e.message}` : "导入失败：需要合法的官方活动 JSON。");
    }
  }

  async function loadArchive(id: string) {
    try {
      const record = await api<{ bundle: unknown }>(`activity-batches/${id}`);
      const bundle = activityBatchSchema.parse(record.bundle);
      if (!bundle.coverage) throw new Error("这份采集包属于旧版格式，已不再展示。请从官方活动页重新采集当前版本。");
      applyBundles([bundle], [id]);
      setBatchSource("archive");
      setActiveView("materials");
      setError("");
    } catch (e) {
      setError(e instanceof Error ? e.message : "历史采集包读取失败");
    }
  }

  async function runTriage() {
    setBusy(true);
    setError("");
    try {
      if (!batchIds.length) throw new Error("请先保存原始采集包。");
      const result = await api<ActivityTriageRecord>("activity-triage", { batchIds, keywords });
      setTriage(result);
      setLastTriageId(result.id);
      setActiveView("recommend");
    } catch (e) {
      setError(e instanceof Error ? e.message : "AI 初筛失败");
    } finally {
      setBusy(false);
    }
  }

  async function run() {
    setBusy(true);
    setError("");
    try {
      const check = manualActivityDeadline(deadlineDate, text);
      if (!check.eligible) throw new Error(check.reason);
      const value = activityPageSchema.parse({ schemaVersion: "draftdesk.activity-page.v1", title, url, text });
      let id = evidenceId;
      if (!id) {
        const result = await api<{ evidenceId: string }>("activity-evidence", value);
        id = result.evidenceId;
        setEvidenceId(id);
      }
      await api("jobs", { planId: "creator-activities", evidenceIds: [id] });
      setDrawer(null);
      await onChange();
      onRun();
    } catch (e) {
      setError(e instanceof Error ? e.message : "分析失败");
    } finally {
      setBusy(false);
    }
  }

  async function runBatch() {
    setBusy(true);
    setError("");
    try {
      if (!eligible.length) throw new Error("没有截止时间明确、未过期且含规则详情的目标活动；请检查采集结果。");
      if (eligible.length > 24) throw new Error("合格活动超过单次研究的 24 条上限。请缩小目标关键词，或分平台导入；未提交的线索仍留在预览中。");
      if (keywords.length > 8) throw new Error("单次研究最多使用 8 个目标关键词，请合并相近词后重试。");
      const ids: string[] = [];
      for (const item of eligible) {
        const result = await api<{ evidenceId: string }>("activity-evidence", {
          schemaVersion: "draftdesk.activity-page.v1",
          title: item.title,
          url: item.url,
          text: `平台：${item.platform}\n${isActivityIndexUrl(item.url) ? `官方活动中心定位：${item.sourceLocator}（此地址不是单条活动链接，分析结果须按标题复核）\n` : ""}活动时间原文：${item.dateText}\n截止时间：${item.endsAt}\n${item.text}`,
        });
        ids.push(result.evidenceId);
      }
      await api("jobs", { planId: "creator-activities", evidenceIds: ids, targetKeywords: keywords });
      await onChange();
      onRun();
    } catch (e) {
      setError(e instanceof Error ? e.message : "批量分析失败");
    } finally {
      setBusy(false);
    }
  }

  const renderActivityRow = (item: ActivityBatchItem, index: number) => {
    const decision = activityBatchDecision(item, keywords);
    const lead = activityBatchLead(item, keywords);
    const status = activityMaterialStatus(item);
    return (
      <article className="activity-raw-row" key={`${item.platform}-${item.title}-${index}`}>
        <div className="activity-raw-main"><div className="activity-row-meta"><span className="activity-platform-tag">{item.platform}</span><span className={`activity-status-tag ${status}`}>{statusLabel[status]}</span><span className={decision.eligible ? "activity-status-tag ready" : lead ? "activity-status-tag review" : "activity-status-tag muted"}>{decision.eligible ? "可分析" : lead ? "待核实" : "暂不匹配"}</span><span>{item.dateText || "时间未知"}</span></div><h4>{item.title}</h4><p>{decision.reason}</p></div>
        <div className="activity-row-actions"><button type="button" onClick={() => inspectItem(item)}>查看原始详情</button>{lead && !decision.eligible && <button type="button" className="secondary" onClick={() => openVerify(item)}>核实规则</button>}<a href={item.url} target="_blank" rel="noopener noreferrer">{isActivityIndexUrl(item.url) ? "打开活动中心 ↗" : "打开官方规则 ↗"}</a></div>
      </article>
    );
  };

  const renderTriage = () => (
    <section className="activity-triage-results activity-view-panel"><div className="activity-panel-heading"><div><span className="activity-eyebrow">AI 整理</span><h3>从原始线索到内容方向</h3></div><span className="activity-count-badge">{triage?.selectedCount ?? 0} 条入模</span></div><p className="activity-panel-intro">AI 只负责相关性整理和方向建议；活动是否仍有效、是否具备报名资格，仍以官方规则核验为准。</p>
      {triage ? <><div className="activity-triage-summary"><strong>{formatDate(triage.createdAt)}</strong><span>输入 {triage.totalCount} 条原始记录</span><span>实际 {triage.modelTokens} tokens</span>{!triageMatchesCurrentBatch && <span className="activity-status-tag review">基于旧快照</span>}</div>{triage.items.length ? ([["high", "高相关"], ["medium", "中相关"], ["low", "低相关"]] as const).map(([level, label]) => { const group = triage.items.filter((item) => item.relevance === level); return group.length ? <section key={level}><div className="activity-relevance-head">{label} · {group.length} 条</div>{group.map((item) => <article key={item.ref} className="activity-triage-card"><div className="activity-row-meta"><span className="activity-platform-tag">{item.platform}</span><span>{item.dateText || "时间未知"}</span></div><h4>{item.title}</h4><p>{item.reason}</p><p><strong>待核事项：</strong>{item.missing.join("；") || "暂无"}</p><a href={item.url} target="_blank" rel="noopener noreferrer">打开原始官方来源 ↗</a>{item.directions.length > 0 && <ol className="activity-direction-list">{item.directions.map((direction, index) => <li key={index}><strong>{direction.title}</strong><span>{direction.angle}</span><small>发布前核实：{direction.verify}</small></li>)}</ol>}</article>)}</section> : null; }) : <div className="activity-empty"><strong>这次没有给出内容方向</strong><p>原始数据仍在「全部材料」中。可以调整关键词或重新采集后再次整理。</p></div>}</> : <div className="activity-empty"><strong>尚未运行 AI 初筛</strong><p>在下方命令条确认关键词后点击「AI 初筛」。原始数据不会因为整理失败而丢失，随时可在「全部材料」查看。</p></div>}
      {triageHistory.length > 1 && <details className="activity-history-inline"><summary>历史 AI 初筛 · {triageHistory.length} 次</summary><div className="activity-history-buttons">{triageHistory.map((row) => <button type="button" key={row.id} onClick={() => void api<ActivityTriageRecord>(`activity-triage/${row.id}`).then((result) => { setTriage(result); setLastTriageId(result.id); }).catch((e) => setError(e.message))}>{formatDate(row.createdAt)} · {row.selectedCount} 条</button>)}</div></details>}
    </section>
  );

  return (
    <section className="surface activity-tools">
      <header className="activity-workbench-header"><div><span className="activity-eyebrow">创作机会工作台</span><h2>创作活动</h2><p>先看四个平台的最新快照，再决定哪些线索值得核实、整理和分析。原始数据与 AI 结果分开保存。</p></div><div className="activity-header-actions"><button type="button" className="secondary" onClick={() => openVerify()}>手动添加活动</button><button type="button" onClick={() => setShowSetup((value) => !value)}>{showSetup ? "收起采集说明" : "显示采集说明"}</button></div></header>
      <div className="activity-platform-grid" aria-label="四个平台采集状态">{activityPlatforms.map((item) => { const snapshot = latestReceived.find((row) => row.platform === item.name); return <article key={item.name} className={snapshot ? "activity-platform-card connected" : "activity-platform-card"}><div className="activity-platform-card-head"><span className="activity-platform-mark">{item.name.slice(0, 1)}</span><strong>{item.name}</strong><span className={snapshot ? "activity-dot online" : "activity-dot"} aria-label={snapshot ? "已采集" : "未采集"} /></div><p>{snapshot ? `${snapshot.count} 条 · ${formatDate(snapshot.receivedAt)}` : "尚未收到快照"}</p><a href={item.url} target="_blank" rel="noopener noreferrer">打开官方入口 ↗</a></article>; })}</div>
      <nav className="activity-tabs" aria-label="创作活动资料视图">{([["recommend", "为我推荐", triage?.items.length ?? 0], ["materials", "全部材料", batch.length], ["history", "历史快照", received.length]] as Array<[ActivityView, string, number]>).map(([view, label, count]) => <button type="button" key={view} className={activeView === view ? "active" : ""} aria-current={activeView === view ? "page" : undefined} onClick={() => setActiveView(view)}>{label}<span>{count}</span></button>)}</nav>
      {showSetup && <>
        <section className="form-section"><span className="activity-step-number">1</span><h3 style={{ display: "inline", marginLeft: 8 }}>选择平台并连接官方活动中心</h3><p className="helper-text">打开官方入口，在自己的 Chrome / Edge 完成登录。工作台不接收账号密码或 Cookie。</p><div style={{ display: "flex", gap: "var(--s3)", alignItems: "end", marginTop: "var(--s3)", flexWrap: "wrap" }}><Field label="平台"><select value={platform} onChange={(event) => setPlatform(Number(event.target.value))}>{activityPlatforms.map((item, index) => <option key={item.name} value={index}>{item.name}</option>)}</select></Field><a className="button" href={activityPlatforms[platform].url} target="_blank" rel="noopener noreferrer">打开{activityPlatforms[platform].name}官方活动入口 ↗</a></div><p className="helper-text">{activityPlatforms[platform].entry}</p></section>
        <section className="form-section"><span className="activity-step-number">2</span><h3 style={{ display: "inline", marginLeft: 8 }}>采集后自动送入本页</h3><p className="helper-text"><a href="/activity-collector.zip" download>下载开源浏览器采集扩展</a>，检查连接后在官方活动页手动启动采集。插件默认连接本机 http://127.0.0.1:5173，失败时可重试或导出 JSON。</p><Field label="导入扩展导出的活动 JSON（最多四份）"><input type="file" accept=".json,application/json" multiple disabled={busy} onChange={(event) => { void load(event.target.files || undefined); event.target.value = ""; }} /></Field></section>
        <section className="form-section"><span className="activity-step-number">3</span><h3 style={{ display: "inline", marginLeft: 8 }}>设定目标关键词并运行</h3><p className="helper-text">关键词同时用于初筛与正式分析的目标限定；最多 8 个。</p><Field label="目标关键词（逗号分隔）"><input value={keywordText} disabled={busy} onChange={(event) => setKeywordText(event.target.value)} /></Field><div className="card-actions" style={{ justifyContent: "flex-start" }}><button type="button" className="primary" disabled={busy || keywords.length === 0 || keywords.length > 8 || priority.length === 0 || priority.length > 12 || batchIds.length === 0} onClick={() => void runTriage()}>{busy ? "正在整理…" : "AI 初筛"}</button><button type="button" disabled={busy || active || keywords.length > 8 || eligible.length === 0 || eligible.length > 24} title={formalReason} onClick={() => void runBatch()}>{busy ? "正在导入…" : "运行正式分析"}</button>{priority.length === 0 && <span className="helper-text">还没有材料：先完成上面两步采集或导入。</span>}</div></section>
      </>}
      {batchSource !== "plugin" && received.length > 0 && <p className="activity-attention"><strong>当前查看的是{batchSource === "archive" ? "历史" : "手动导入"}数据。</strong> <button type="button" onClick={() => { setLastReceivedSignature(""); setBatchSource("plugin"); }}>切回四个平台最新快照</button></p>}
      {activeView === "history" && <section className="activity-history-panel activity-view-panel"><div className="activity-panel-heading"><div><span className="activity-eyebrow">原始档案</span><h3>每次采集都可追溯</h3></div><span className="activity-count-badge">{received.length} 份</span></div><p className="activity-panel-intro">历史快照不会被 AI 整理覆盖。选择一份后，工作台会把它放进「全部材料」视图。</p>{received.length ? <div className="activity-history-grid">{received.map((row) => <button type="button" key={row.id} className="activity-history-card" onClick={() => void loadArchive(row.id)}><span>{row.platform}</span><strong>{row.count} 条</strong><small>{formatDate(row.receivedAt)}</small><em>查看快照 →</em></button>)}</div> : <div className="activity-empty"><strong>还没有历史采集包</strong><p>完成一次采集或导入后，原始包会自动保存在本机。</p></div>}</section>}
      {activeView === "recommend" && hasBatch && !triageMatchesCurrentBatch && priority.length > 0 && <div className="activity-pending-banner"><span>最新快照有 <strong>{eligible.length}</strong> 条可分析、<strong>{relevantLeads.length}</strong> 条待核实线索，尚未运行 AI 初筛。</span><div className="activity-pending-actions"><button type="button" className="primary" disabled={busy || keywords.length === 0 || keywords.length > 8 || priority.length === 0 || priority.length > 12 || batchIds.length === 0} onClick={() => void runTriage()}>{busy ? "正在整理…" : "AI 初筛"}</button><button type="button" onClick={() => setActiveView("materials")}>先看全部材料</button></div></div>}
      {activeView === "recommend" && renderTriage()}
      {activeView === "recommend" && !hasBatch && <section className="activity-empty activity-first-run"><strong>等待第一份活动快照</strong><p>在四个平台的官方活动中心完成采集，或导入扩展导出的 JSON。采集完成后，数据会先出现在「全部材料」，确认后再调用 AI。</p><button type="button" className="secondary" onClick={() => setShowSetup(true)}>查看采集步骤</button></section>}
      {activeView === "materials" && hasBatch && <section className="activity-snapshot-panel activity-view-panel"><div className="activity-panel-heading"><div><span className="activity-eyebrow">{batchSource === "archive" ? "历史快照" : "当前原始快照"}</span><h3>{batch.length} 条原始活动记录</h3></div><div className="activity-metric-group"><span><strong>{eligible.length}</strong> 可分析</span><span><strong>{relevantLeads.length}</strong> 待核实</span><span><strong>{batch.length - priority.length}</strong> 暂不匹配</span></div></div><details className="activity-coverage-details"><summary><strong>采集覆盖</strong>{batchCoverage.map((row) => `${row.platform} ${row.short}`).join(" · ")}<span className="activity-coverage-count">{batchWarnings.length} 条说明</span></summary><div className="activity-coverage-body"><p>以下记录说明本次采集的范围与限制：标题、时间原文、官方链接、正文摘录和采集时间均原样保留；入库时间只表示何时送到工作台，不代表平台没有更新。</p>{batchCoverage.map((row, index) => <p key={`c${index}`}><strong>{row.platform}：</strong>{row.summary}</p>)}{batchWarnings.map((warning, index) => <p key={`w${index}`}>{warning}</p>)}</div></details>{eligible.length === 0 && relevantLeads.length > 0 && <p className="activity-attention">这批材料有值得核实的活动，但缺少可验证的截止年份或完整规则。打开单条记录，从官方详情补齐规则。</p>}{batch.length === 0 ? <div className="activity-empty"><strong>这次没有读到活动</strong><p>请检查登录状态、活动页是否加载完成和扩展提示。0 条只代表本次采集没有带回记录，不能推断平台没有活动。</p></div> : <><div className="activity-filter-bar" role="group" aria-label="材料筛选"><div className="activity-chip-group"><span className="activity-chip-label">平台</span>{["全部", ...platformsInBatch].map((name) => <button type="button" key={name} className={`activity-chip ${platformFilter === name ? "active" : ""}`} onClick={() => setPlatformFilter(name)}>{name}<span>{name === "全部" ? batch.length : platformCounts.get(name) || 0}</span></button>)}</div><div className="activity-chip-group"><span className="activity-chip-label">状态</span>{([["all", "全部"], ["live", "进行中"], ["expired", "已过期"], ["unknown", "日期不明"]] as const).map(([value, label]) => <button type="button" key={value} className={`activity-chip ${statusFilter === value ? "active" : ""}`} onClick={() => setStatusFilter(value)}>{label}<span>{value === "all" ? batch.filter((item) => materialPass(item, "status")).length : statusCounts.get(value) || 0}</span></button>)}</div><div className="activity-chip-group"><span className="activity-chip-label">匹配</span>{([["all", "全部"], ["matched", "命中关键词"], ["unmatched", "未命中"]] as const).map(([value, label]) => <button type="button" key={value} className={`activity-chip ${matchFilter === value ? "active" : ""}`} onClick={() => setMatchFilter(value)}>{label}<span>{value === "all" ? batch.filter((item) => materialPass(item, "match")).length : matchCount(value)}</span></button>)}</div><input className="activity-raw-search" type="search" aria-label="搜索标题或正文" placeholder="搜索标题或正文…" value={rawQuery} onChange={(event) => setRawQuery(event.target.value)} /></div>{filteredMaterials.length === 0 ? <div className="activity-empty"><strong>没有符合筛选的材料</strong><p>调整或清除筛选，查看全部 {batch.length} 条记录。</p><button type="button" className="secondary" onClick={clearMaterialFilters}>清除筛选</button></div> : platformFilter === "全部" ? platformsInBatch.map((name) => { const groupItems = filteredMaterials.filter((item) => item.platform === name); const liveCount = groupItems.filter((item) => activityMaterialStatus(item) === "live").length; return <div key={name}><div className="activity-platform-section-head"><strong>{name}</strong><span>{groupItems.length} 条 · {liveCount} 进行中</span></div><div className="activity-raw-list">{groupItems.map(renderActivityRow)}</div></div>; }) : <div className="activity-raw-list">{filteredMaterials.map(renderActivityRow)}</div>}</>}</section>}
      {activeView === "materials" && !hasBatch && <section className="activity-empty activity-first-run"><strong>还没有可展示的原始快照</strong><p>完成一次四平台采集或导入 JSON 后，所有原始活动都会在这里保留。</p><button type="button" className="secondary" onClick={() => setShowSetup(true)}>查看导入方式</button></section>}
      {(activeView === "recommend" || activeView === "materials") && hasBatch && <p className="muted" style={{ margin: "var(--s2) 0" }}>下一步：{eligible.length ? formalReason : "先核实待处理线索，或调整关键词"}。运行按钮在「开始采集」第 3 步。</p>}
      {priority.length > 12 && (activeView === "recommend" || activeView === "materials") && <p className="error">AI 初筛单次最多 12 条相关线索，请缩小关键词或分平台查看历史快照。</p>}{eligible.length > 24 && (activeView === "recommend" || activeView === "materials") && <p className="error">合格活动超过单次 24 条上限，请缩小目标关键词或分平台导入。</p>}{keywords.length > 8 && <p className="error">单次研究最多使用 8 个目标关键词，请合并相近词。</p>}{triage && hasBatch && !triageMatchesCurrentBatch && activeView !== "recommend" && <p className="activity-attention">AI 整理基于历史采集包，与当前显示的原始快照不同。切到「为我推荐」查看旧结果，确认新快照后再重新运行。</p>}{error && <p className="error" role="alert">{error}</p>}
      {drawer === "detail" && selectedItem && <Drawer title={selectedItem.title} subtitle={`${selectedItem.platform} · ${selectedItem.dateText || "时间未知"}`} onClose={() => setDrawer(null)} wide><div className="activity-detail-stack"><div className="activity-row-meta"><span className="activity-platform-tag">{selectedItem.platform}</span><span>{selectedItem.completeness === "detail" ? "详情正文" : "列表摘要"}</span><span>采集于 {formatDate(selectedItem.capturedAt)}</span></div><p><strong>判断：</strong>{activityBatchDecision(selectedItem, keywords).reason}</p><p><strong>官方来源：</strong><a href={selectedItem.url} target="_blank" rel="noopener noreferrer">{selectedItem.url} ↗</a></p><h3>原始摘录</h3><pre className="activity-raw-text">{selectedItem.text || "此条只有标题，没有正文摘录。"}</pre><div className="activity-detail-actions"><button className="primary" onClick={() => openVerify(selectedItem)}>核实规则并分析</button><a href={selectedItem.url} target="_blank" rel="noopener noreferrer">打开官方页面 ↗</a></div></div></Drawer>}
      {drawer === "verify" && <Drawer title="核实活动规则" subtitle={selectedLead || "手动添加一条官方活动"} onClose={() => setDrawer(null)} wide>{selectedLead && <p className="activity-attention">请从官方详情补全规则正文，并确认其中写明截止年份。列表摘要不能代替规则。</p>}<Field label="活动名称"><input value={title} disabled={busy} onChange={(event) => { setTitle(event.target.value); reset(); }} maxLength={300} /></Field><Field label="官方活动地址"><input value={url} disabled={busy} onChange={(event) => { setUrl(event.target.value); reset(); }} /></Field><Field label="规则正文" hint="至少 50 字；正文必须能支撑截止日期和参与条件。"><textarea rows={10} value={text} disabled={busy} maxLength={12000} onChange={(event) => { setText(event.target.value); reset(); }} /></Field><Field label="投稿截止日期（从规则正文核对）"><input type="date" value={deadlineDate} disabled={busy} onChange={(event) => setDeadlineDate(event.target.value)} /></Field><p className="field-help">{text.length} / 12000 字 · 已过期或日期无法从官方规则核对的活动不会提交模型。</p>{deadlineDate && text.trim().length >= 50 && !manualActivityDeadline(deadlineDate, text).eligible && <p className="error">{manualActivityDeadline(deadlineDate, text).reason}</p>}<div className="activity-detail-actions"><button className="primary" disabled={busy || active || text.trim().length < 50 || title.trim().length < 3 || !url || !manualActivityDeadline(deadlineDate, text).eligible} onClick={() => void run()}>{busy ? "正在提交…" : active ? "活动分析进行中" : "保存规则并分析"}</button><button type="button" onClick={() => setDrawer(null)}>稍后处理</button></div>{evidenceId && <p className="notice">原文已保存，失败可重试创建分析任务。</p>}</Drawer>}
    </section>
  );
}
