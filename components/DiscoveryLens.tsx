"use client";
import {useState,useEffect} from "react";
import type {DiscoveryRecord} from "../core/discovery";
import {date, api} from "./ui";

// 注意力判级徽章（R9-6③）：AI 语义初筛产出，随 candidate.reason/groupId 一并审查台可见
const ATTENTION_BADGE: Record<string,{label:string;cls:string}>={
  strong:{label:"● 强注意力",cls:"att-strong"},
  potential:{label:"◐ 潜力",cls:"att-potential"},
  none:{label:"○ 无注意力",cls:"att-none"},
};

// R10.13：workspace 的 discovery 是轻量摘要（无 candidates）——Lens 挂载时按需拉全量
export function DiscoveryLens({record: slim, mode}: { record: DiscoveryRecord | null; mode: "watch" | "coverage" }) {
  const [record, setRecord] = useState<DiscoveryRecord | null>(null);
  useEffect(() => {
    if (!slim?.jobId) { setRecord(null); return; }
    if ((slim as any).candidates) { setRecord(slim); return; } // 已是全量（测试/直传场景）
    void api<DiscoveryRecord>("discovery/" + slim.jobId).then(setRecord).catch(() => setRecord(null));
  }, [slim?.jobId]);

  const [query,setQuery]=useState(""),[includeFiltered,setIncludeFiltered]=useState(false),[page,setPage]=useState(1);
  if(!record)return <section className="lens-empty"><h2>还没有采集覆盖记录</h2><p>可以先做一次只采集预览，查看来源、筛选和失败情况；正式研究才会调用 AI。外部 Agent 提交的材料按收件回执查看。</p></section>;
  const watched=record.candidates.filter(c=>c.status==="watch"||(includeFiltered&&c.status==="filtered"));
  const needle=query.trim().toLocaleLowerCase();
  const filtered=watched.filter(c=>!needle||`${c.title} ${c.sourceName} ${c.reason}`.toLocaleLowerCase().includes(needle));
  const pageSize=20,pages=Math.max(1,Math.ceil(filtered.length/pageSize)),current=Math.min(page,pages);
  if(mode==="coverage"){
    const totals=record.sources.reduce((acc,s)=>({raw:acc.raw+s.raw,matched:acc.matched+s.matched,selected:acc.selected+s.selected}),{raw:0,matched:0,selected:0});
    const failed=record.sources.filter(s=>s.status==="failed").length;
    const rate=totals.raw?Math.round(totals.selected/totals.raw*1000)/10:0;
    return <section className="lens-panel" aria-label="采集覆盖报告">
      <header><div><h2>{record.planName} · 采集覆盖{record.mode==="preview"?"（只采集预览）":""}</h2><p>{date(record.at)} · 本轮最多保留 {record.limit} 条证据。{record.mode==="preview"?"未调用 AI，尚未生成推荐。":"榜单标题是线索，未入选不等于无价值。"}</p></div></header>
      <div className="coverage-funnel" role="img" aria-label={`漏斗：读取 ${totals.raw} 条，匹配 ${totals.matched} 条，${record.mode==="preview"?"保留":"进入分析"} ${totals.selected} 条`}>
        <div className="coverage-funnel-bar" aria-hidden="true">
          {totals.raw>0&&<>
            <span className="funnel-seg funnel-raw" style={{flex:totals.raw}}/>
            <span className="funnel-seg funnel-matched" style={{flex:totals.matched}}/>
            <span className="funnel-seg funnel-selected" style={{flex:totals.selected}}/>
          </>}
        </div>
        <div className="coverage-funnel-stats">
          <span><strong>{totals.raw}</strong> 读取条目</span>
          <span className="funnel-arrow" aria-hidden="true">→</span>
          <span><strong>{totals.matched}</strong> 匹配策略</span>
          <span className="funnel-arrow" aria-hidden="true">→</span>
          <span><strong>{totals.selected}</strong> {record.mode==="preview"?"保留证据":"进入分析"}</span>
          <span className="funnel-rate">入模率 {rate}%</span>
          {failed>0&&<span className="funnel-failed">{failed} 个来源读取失败</span>}
        </div>
      </div>
      <div className="coverage-list">{record.sources.map(s=>{
        const ok=s.status!=="failed";
        return <article key={s.sourceId} className={s.status==="failed"?"failed coverage-source":"coverage-source"}>
          <div className="coverage-source-head">
            <strong><span className={ok?"coverage-dot ok":"coverage-dot failed-dot"} aria-hidden="true"/>{s.sourceName}</strong>
            {!ok&&<small className="coverage-failed-label">读取失败</small>}
          </div>
          {ok&&s.raw>0&&<div className="coverage-source-bar" aria-hidden="true">
            <span className="funnel-seg funnel-raw" style={{flex:s.raw}}/>
            <span className="funnel-seg funnel-matched" style={{flex:s.matched}}/>
            <span className="funnel-seg funnel-selected" style={{flex:s.selected}}/>
          </div>}
          <p>{ok?`读取 ${s.raw} · 匹配 ${s.matched} · ${record.mode==="preview"?"保留":"入模"} ${s.selected}${s.raw?` · ${Math.round(s.selected/s.raw*1000)/10}%`:""}`:s.error}</p>
        </article>;
      })}</div>
      <p className="lens-note">未命中关键词、超出证据预算和来源失败都可能造成遗漏。可调整研究策略后再运行；本报告不代表全网覆盖率。</p>
    </section>;
  }
  return <section className="lens-panel" aria-label="待观察线索">
    <header><div><h2>待观察线索</h2><p>{record.planName} · {date(record.at)}。这些条目尚未作为 AI 推荐；请打开原始来源核对。</p></div></header>
    <div className="lens-controls"><input aria-label="搜索待观察线索" placeholder="搜索线索、来源或筛除原因" value={query} onChange={e=>{setQuery(e.target.value);setPage(1);}}/><label><input type="checkbox" checked={includeFiltered} onChange={e=>{setIncludeFiltered(e.target.checked);setPage(1);}}/> 包含规则筛除</label></div>
    {!filtered.length?<p className="lens-note">{record.candidates.length?"当前筛选下没有待观察线索。可勾选规则筛除，检查关键词是否太窄。":"本轮没有采集到候选条目；查看采集覆盖了解来源状态。"}</p>:<div className="lens-list">{filtered.slice((current-1)*pageSize,current*pageSize).map((c,i)=><article key={`${c.sourceId}-${c.url}-${i}`}><div><span>{c.sourceName}</span>{c.attention&&ATTENTION_BADGE[c.attention]&&<small className={`lens-attention ${ATTENTION_BADGE[c.attention].cls}`}>{ATTENTION_BADGE[c.attention].label}</small>}<small>{c.status==="filtered"?"规则筛除":"证据名额外"} · {c.reason}</small></div><a href={c.url} target="_blank" rel="noreferrer">{c.title} ↗</a></article>)}</div>}
    {pages>1&&<nav className="lens-pages" aria-label="待观察分页"><button disabled={current<=1} onClick={()=>setPage(current-1)}>上一页</button><span>{current} / {pages}</span><button disabled={current>=pages} onClick={()=>setPage(current+1)}>下一页</button></nav>}
  </section>;
}
