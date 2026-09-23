"use client";
import { useEffect, useState } from "react";
import type { ResearchEvent, MetricSnapshot } from "../core/history";
import { api, date } from "./ui";
type History = { events: ResearchEvent[]; metrics: (MetricSnapshot & {comparison:{percent:number|null;reason:string}})[]; related: {id:string;title:string}[] };
export function ResearchHistory({artifactId}:{artifactId:string}) {
  const [value,setValue] = useState<History | null>(null), [error,setError] = useState("");
  useEffect(()=>{ let alive=true; setValue(null); setError(""); api<History>("history/"+artifactId).then(v=>{if(alive)setValue(v)}).catch(()=>{if(alive)setError("历史记录读取失败，请重新打开详情。")}); return ()=>{alive=false}; },[artifactId]);
  return <section className="research-history"><h3>事件与指标历史</h3>
    {error && <p role="alert">{error}</p>}
    {!value && !error && <p>正在读取历史…</p>}
    {value && <>
      {!value.events.length && <p>暂无历史关联；不会据此推断增长。</p>}
      {value.events.map(e=><details key={e.id}><summary>{e.title} · {e.revisions.filter(r=>r.change==="update").length} 次更新 · {e.revisions.filter(r=>r.change==="duplicate").length} 条转载/重复</summary>
        <p>首次 {date(e.firstSeen)} · 最近采集 {date(e.lastSeen)}</p>
        <ol>{e.revisions.map(r=><li key={r.evidenceId}>{date(r.at)} · {{new:"首次记录",update:"资料有变化，仍需核对事实",duplicate:"相同材料，未算独立变化"}[r.change]}</li>)}</ol>
      </details>)}
      {value.metrics.length > 0 ? <div className="metric-history"><p>指标按来源、主题、地域、单位和采样周期分别记录。分桶文本不转换成精确值。</p>
        {value.metrics.map(m=><article key={m.id}><strong>{m.title} · {m.name}</strong><p>{m.value} {m.unit} · {m.region} · {m.period}</p>
          <p>{m.comparison.percent === null ? "不计算增速" : `同口径变化 ${m.comparison.percent > 0 ? "+" : ""}${m.comparison.percent}%`} · {m.comparison.reason}</p></article>)}
      </div> : <p>没有原始指标快照：只能作为线索，不能视为已验证的增长趋势。</p>}
      {!!value.related.length && <div><h4>同事件已有研究</h4><ul>{value.related.map(a=><li key={a.id}>{a.title}</li>)}</ul><small>可在工作台按标题搜索；同事件关联使用保守匹配，不代表独立交叉验证。</small></div>}
    </>}
  </section>;
}
