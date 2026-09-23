import { evidenceReadiness } from "../core/readiness";
import { metricComparison, type MetricSnapshot } from "../core/history";
import type { Artifact, Evidence } from "../core/schema";
// Read-only material audit. No provider calls and no workspace writes.
const response = await fetch(`${process.env.DRAFTDESK_ACCEPTANCE_URL || "http://host.docker.internal:5173"}/api/v1/export`);
if (!response.ok) throw new Error(`读取失败：${response.status}`);
const data = await response.json() as {artifacts:Artifact[];evidence:Evidence[];metrics:MetricSnapshot[]};
const items = data.artifacts.map(a=>({id:a.id,kind:a.kind,checks:evidenceReadiness(a,data.evidence).map(({key,status})=>({key,status}))}));
console.log(JSON.stringify({at:new Date().toISOString(),mode:"read-only, no AI calls",artifactCount:items.length,
  summary: [...new Set(items.map(a=>a.kind))].map(kind=>({kind,items:items.filter(a=>a.kind===kind).length,
    missing:items.filter(a=>a.kind===kind).flatMap(a=>a.checks.filter(c=>c.status==="missing").map(c=>c.key))})),
  comparableMetricCount:data.metrics.filter(m=>metricComparison(data.metrics,m).percent!==null).length,
  note:"候选材料并非已验证结论；此报告不能替代真实模型 A/B 评分。",items},null,2));
