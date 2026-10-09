"use client";
// 数据源视图（PHASE 5 自 Workbench.tsx 纯移动拆出；JSX 与拆分前逐字一致）。
import { api, date } from "../ui";
import type { Workspace, Snapshot } from "../useWorkspaceData";

export function SourcesView({ ws, data }: { ws: Workspace; data: Snapshot }) {
  const { setSource, sourceChecks, setSourceChecks } = ws;
  return (
    <>
      <div className="toolbar">
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
      <div className="source-list">
        {data.sources.map((s) => (
          <article className="source-row" key={s.id}>
            <div>
              <span className="pill">{s.type.toUpperCase()}</span>
              <h2>{s.name}</h2>
              <p>{s.note}</p>
              <small>
                {s.url ||
                  s.query ||
                  s.region ||
                  "使用策略中的关键词"}{" "}
                · {s.enabled ? "已启用" : "已停用"}
              </small>
            </div>
            <div className="source-actions">
              {s.type === "aggregated" && <button disabled={sourceChecks[s.id] === "检测中…"} onClick={async () => {
                setSourceChecks(old => ({ ...old, [s.id]: "检测中…" }));
                try { const result = await api<{ count: number; updatedAt: string }>("source-check", { sourceId: s.id }); setSourceChecks(old => ({ ...old, [s.id]: `可用 · ${result.count} 条 · 更新于 ${date(result.updatedAt)}` })); }
                catch (e) { setSourceChecks(old => ({ ...old, [s.id]: `失败 · ${(e as Error).message}` })); }
              }}>检测连接</button>}
              <button onClick={() => setSource(s)}>配置</button>
              {sourceChecks[s.id] && <small role="status">{sourceChecks[s.id]}</small>}
            </div>
          </article>
        ))}
      </div>
      <p className="context-note">
        百度热搜、Google Trends 地域榜、GitHub Trending 与 Hacker News Top 已接入。B站热门与微博热搜走官方公开接口（内置、匿名可用）；本地 DailyHotApi 聚合已验证知乎、抖音、头条、贴吧和掘金，快手上游仍失败、默认停用。可逐个检测连接后启用。聚合榜单显示获取方式和更新时间，只作线索，需核对原平台内容。登录后的创作者活动须走活动采集流程。
      </p>
    </>
  );
}
