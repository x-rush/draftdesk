"use client";
import {useState} from "react";
import type {DiscoveryRecord} from "../core/discovery";
import {date} from "./ui";

export function DiscoveryLens({record,mode}:{record:DiscoveryRecord|null;mode:"watch"|"coverage"}){
  const [query,setQuery]=useState(""),[includeFiltered,setIncludeFiltered]=useState(false),[page,setPage]=useState(1);
  if(!record)return <section className="lens-empty"><h2>还没有采集覆盖记录</h2><p>可以先做一次只采集预览，查看来源、筛选和失败情况；正式研究才会调用 AI。外部 Agent 提交的材料按收件回执查看。</p></section>;
  const watched=record.candidates.filter(c=>c.status==="watch"||(includeFiltered&&c.status==="filtered"));
  const needle=query.trim().toLocaleLowerCase();
  const filtered=watched.filter(c=>!needle||`${c.title} ${c.sourceName} ${c.reason}`.toLocaleLowerCase().includes(needle));
  const pageSize=20,pages=Math.max(1,Math.ceil(filtered.length/pageSize)),current=Math.min(page,pages);
  if(mode==="coverage")return <section className="lens-panel" aria-label="采集覆盖报告">
    <header><div><h2>{record.planName} · 采集覆盖{record.mode==="preview"?"（只采集预览）":""}</h2><p>{date(record.at)} · 本轮最多保留 {record.limit} 条证据。{record.mode==="preview"?"未调用 AI，尚未生成推荐。":"榜单标题是线索，未入选不等于无价值。"}</p></div></header>
    <div className="coverage-summary"><div><strong>{record.sources.reduce((n,s)=>n+s.raw,0)}</strong><span>读取条目</span></div><div><strong>{record.sources.reduce((n,s)=>n+s.matched,0)}</strong><span>匹配策略</span></div><div><strong>{record.sources.reduce((n,s)=>n+s.selected,0)}</strong><span>{record.mode==="preview"?"保留证据":"进入分析"}</span></div><div><strong>{record.sources.filter(s=>s.status==="failed").length}</strong><span>来源失败</span></div></div>
    <div className="coverage-list">{record.sources.map(s=><article key={s.sourceId} className={s.status==="failed"?"failed":""}><div><strong>{s.sourceName}</strong><small>{s.status==="failed"?"读取失败":"已读取"}</small></div><p>{s.status==="failed"?s.error:`读取 ${s.raw} · 匹配 ${s.matched} · 入模 ${s.selected}`}</p></article>)}</div>
    <p className="lens-note">未命中关键词、超出证据预算和来源失败都可能造成遗漏。可调整研究策略后再运行；本报告不代表全网覆盖率。</p>
  </section>;
  return <section className="lens-panel" aria-label="待观察线索">
    <header><div><h2>待观察线索</h2><p>{record.planName} · {date(record.at)}。这些条目尚未作为 AI 推荐；请打开原始来源核对。</p></div></header>
    <div className="lens-controls"><input aria-label="搜索待观察线索" placeholder="搜索线索、来源或筛除原因" value={query} onChange={e=>{setQuery(e.target.value);setPage(1);}}/><label><input type="checkbox" checked={includeFiltered} onChange={e=>{setIncludeFiltered(e.target.checked);setPage(1);}}/> 包含规则筛除</label></div>
    {!filtered.length?<p className="lens-note">{record.candidates.length?"当前筛选下没有待观察线索。可勾选规则筛除，检查关键词是否太窄。":"本轮没有采集到候选条目；查看采集覆盖了解来源状态。"}</p>:<div className="lens-list">{filtered.slice((current-1)*pageSize,current*pageSize).map((c,i)=><article key={`${c.sourceId}-${c.url}-${i}`}><div><span>{c.sourceName}</span><small>{c.status==="filtered"?"规则筛除":"证据名额外"} · {c.reason}</small></div><a href={c.url} target="_blank" rel="noreferrer">{c.title} ↗</a></article>)}</div>}
    {pages>1&&<nav className="lens-pages" aria-label="待观察分页"><button disabled={current<=1} onClick={()=>setPage(current-1)}>上一页</button><span>{current} / {pages}</span><button disabled={current>=pages} onClick={()=>setPage(current+1)}>下一页</button></nav>}
  </section>;
}
