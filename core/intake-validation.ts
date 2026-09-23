import { intakeSchema } from "./schema";
export function validateIntake(input: unknown) {
  const parsed = intakeSchema.safeParse(input);
  if (!parsed.success) return {ok:false,errors:parsed.error.issues.map(i=>({path:i.path.join("."),message:i.message}))};
  const p=parsed.data, ids=new Set<string>(), errors:{path:string;message:string}[]=[];
  const explicit=new Set<string>();
  p.evidence.forEach((e,i)=>{if(e.id && (explicit.has(e.id) || (/^\d+$/.test(e.id) && Number(e.id)<p.evidence.length && e.id!==String(i))))errors.push({path:`evidence.${i}.id`,message:"证据 ID 重复或与位置别名冲突"});if(e.id){ids.add(e.id);explicit.add(e.id)}ids.add(String(i));});
  p.drafts.forEach((d,i)=>{
    const refs=[...d.evidenceIds,...d.claims.flatMap(c=>c.evidenceIds),...(d.kind==="trend"?d.details.signalEvidenceIds:[])];
    if(refs.some(id=>!ids.has(id)))errors.push({path:`drafts.${i}`,message:"引用必须来自同一提交的证据"});
    if(d.claims.some(c=>c.evidenceIds.some(id=>!d.evidenceIds.includes(id))) || (d.kind==="trend" && d.details.signalEvidenceIds.some(id=>!d.evidenceIds.includes(id)))) errors.push({path:`drafts.${i}.evidenceIds`,message:"陈述和指标引用须列入产物证据集"});
  });
  return {ok:!errors.length,errors,evidenceCount:p.evidence.length,draftCount:p.drafts.length,note:"仅验证协议与引用；未验证事实、搜索工具或内容质量，未入库。"};
}
