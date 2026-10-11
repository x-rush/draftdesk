"use client";
// 数据源 · 信号台版（分类批）：type 归入四个用户向分类（搜索与趋势/热榜/社区与官方/网页搜索），
// 统计条 + 分类 chips + 停用显示开关 + 紧凑源行（状态点+名称+说明钳 1 行+端点，检测/配置右贴）。
// 分类只做展示层归组，不改 sources.type 采集机制。
import { useMemo, useState } from "react";
import { api, date } from "../ui";
import type { Workspace, Snapshot } from "../useWorkspaceData";

const TYPE_LABELS: Record<string, string> = { rss: "RSS", github: "GitHub", hotlist: "热榜官方", aggregated: "聚合榜单", trends: "Trends", web: "网页搜索", suggest: "搜索联想" };
const CATEGORY_OF: Record<string, string> = { trends: "search", suggest: "search", hotlist: "hotlist", aggregated: "hotlist", rss: "community", github: "community", web: "web" };
const CATEGORIES: Array<[string, string, string]> = [
  ["search", "🔍 搜索与趋势", "Google Trends 七国地域榜 + 搜索联想需求雷达"],
  ["hotlist", "🔥 热榜", "官方热榜接口与本地聚合榜单（聚合可逐个检测连接）"],
  ["community", "🏛 社区与官方", "官方博客与产品声明、社区讨论、仓库与新产品动态"],
  ["web", "🌐 网页搜索", "Tavily 按策略关键词搜索"],
];

export function SourcesView({ ws, data }: { ws: Workspace; data: Snapshot }) {
  const { setSource, sourceChecks, setSourceChecks } = ws;
  const [cat, setCat] = useState("");
  const [showDisabled, setShowDisabled] = useState(true);
  const sources = data.sources || [];
  const enabledCount = sources.filter((s) => s.enabled !== false).length;
  const disabledCount = sources.length - enabledCount;
  const aggregatedCount = sources.filter((s) => s.type === "aggregated").length;

  const visible = useMemo(() => (cat ? sources.filter((s) => (CATEGORY_OF[s.type] ?? "community") === cat) : sources), [sources, cat]);
  const shown = showDisabled ? visible : visible.filter((s) => s.enabled !== false);
  const byCat = (key: string) => sources.filter((s) => (CATEGORY_OF[s.type] ?? "community") === key);

  async function checkSource(id: string) {
    setSourceChecks((old) => ({ ...old, [id]: "检测中…" }));
    try {
      const result = await api<{ count: number; updatedAt: string }>("source-check", { sourceId: id });
      setSourceChecks((old) => ({ ...old, [id]: `可用 · ${result.count} 条 · 更新于 ${date(result.updatedAt)}` }));
    } catch (e) {
      setSourceChecks((old) => ({ ...old, [id]: `失败 · ${(e as Error).message}` }));
    }
  }

  const row = (s: any) => {
    const on = s.enabled !== false;
    const endpoint = (s.url || s.query || "").replace(/^https?:\/\//, "").slice(0, 46);
    return (
      <div className="term-row" key={s.id}>
        <div className="term-main">
          <span className={"activity-dot" + (on ? " online" : "")} aria-label={on ? "已启用" : "已停用"} style={{ flex: "none" }} />
          <div className="source-cell">
            <div className="term-title-line">
              <button className="term-name" onClick={() => setSource(s)} title={s.note}>{s.name}</button>
              <span className="pill">{TYPE_LABELS[s.type] || s.type}</span>
              {!on && <span className="pill">已停用</span>}
            </div>
            <p className="source-note">{s.note}</p>
          </div>
          <span className="term-meta">
            <span title={s.url || s.query || ""}>{endpoint || (s.region ? `地区 ${s.region}` : "策略关键词")}</span>
          </span>
        </div>
        <div className="term-actions">
          {s.type === "aggregated" && (
            <button disabled={sourceChecks[s.id] === "检测中…"} onClick={() => void checkSource(s.id)}>
              {sourceChecks[s.id]?.startsWith("可用") ? "再检测" : "检测连接"}
            </button>
          )}
          <button onClick={() => setSource(s)}>配置</button>
        </div>
        {sourceChecks[s.id] && (
          <div style={{ gridColumn: "1 / -1" }}>
            <small role="status" className="muted">{s.name}：{sourceChecks[s.id]}</small>
          </div>
        )}
      </div>
    );
  };

  return (
    <>
      {/* ① 统计条 */}
      <div className="stat-strip">
        <div className="stat-card"><strong>{sources.length}</strong><span>数据源</span><small>分 4 类管理，点下方分类筛选</small></div>
        <div className="stat-card accent"><strong>{enabledCount}</strong><span>✅ 已启用</span><small>进入策略调度与热词挖掘</small></div>
        <div className="stat-card"><strong>{disabledCount}</strong><span>⏸ 已停用</span><small>{showDisabled ? "列表中灰点显示，可在配置里启用" : "当前已隐藏"}</small></div>
        <div className="stat-card"><strong>{aggregatedCount}</strong><span>🔁 聚合可检测</span><small>本地 DailyHotApi，逐个检测连接</small></div>
      </div>

      {/* ② 分类 chips + 工具 */}
      <div className="radar-toolbar">
        <nav className="discovery-modes" aria-label="来源分类筛选">
          <button className={cat === "" ? "active" : ""} aria-current={cat === "" ? "page" : undefined} onClick={() => setCat("")}>全部 {sources.length}</button>
          {CATEGORIES.map(([key, label]) => (
            <button key={key} className={cat === key ? "active" : ""} aria-current={cat === key ? "page" : undefined} onClick={() => setCat(key)}>{label} {byCat(key).length}</button>
          ))}
        </nav>
        <label className="check" style={{ margin: "0 0 0 auto" }}>
          <input type="checkbox" checked={showDisabled} onChange={(e) => setShowDisabled(e.target.checked)} />
          显示已停用
        </label>
        <button
          className="primary"
          onClick={() =>
            setSource({
              id: crypto.randomUUID(),
              name: "新的公开来源",
              type: "rss",
              sourceType: "media",
              enabled: true,
              note: "",
            })
          }
        >
          ＋ 添加来源
        </button>
      </div>

      {/* ③ 源列表：全部=分组带说明；单类=平铺 */}
      {shown.length === 0 ? (
        <p className="muted" style={{ padding: "16px 2px" }}>该分类下没有符合条件的来源{showDisabled ? "" : "（已停用的被隐藏，勾选「显示已停用」可看全）"}。</p>
      ) : (
        (cat === "" ? CATEGORIES.filter(([key]) => byCat(key).length).map(([key, label, desc]) => (
          <section key={key}>
            <p className="dash-label">{label}<span className="dash-label-sub">{byCat(key).length} 个 · {desc}</span></p>
            <div className="term-list">{byCat(key).filter((s) => showDisabled || s.enabled !== false).map(row)}</div>
          </section>
        )) : (
          <section>
            <p className="dash-label">{CATEGORIES.find(([k]) => k === cat)?.[1]}<span className="dash-label-sub">{CATEGORIES.find(([k]) => k === cat)?.[2]}</span></p>
            <div className="term-list">{shown.map(row)}</div>
          </section>
        ))
      )}
      <p className="context-note">
        聚合榜单（本地 DailyHotApi）可逐个「检测连接」后启用；榜单只作线索，需核对原平台内容。登录后的创作者活动须走活动采集流程。分类只影响这里的浏览归组，不改变采集机制。
      </p>
    </>
  );
}
