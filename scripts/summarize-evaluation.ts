import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
const directory = process.argv[2];
if (!directory) throw Error("传入已有评测目录；此命令不调用模型。");
const report = JSON.parse(readFileSync(path.join(directory,"report.json"),"utf8"));
const review = JSON.parse(readFileSync(path.join(directory,"review.json"),"utf8"));
const labels = ["A","B"];
const rows = labels.map(label=>{
  const output = report.outputs.find((o:any)=>o.label===label);
  const ratings = (review.dimensions || []).map((d:any)=>d[label]);
  const complete = ratings.length===5 && ratings.every((r:any)=>Number.isInteger(r) && r>=0 && r<=4)
    && review.dimensions.every((d:any)=>typeof d.evidence==="string" && d.evidence.trim());
  return {label,semanticScore:complete ? ratings.reduce((a:number,b:number)=>a+b,0)/2 : null,
    status:output?.error ? "调用失败" : !output ? "未运行" : !complete ? "待人工盲审" : "已评分",
    schemaPassed:output?.schemaPassed ?? null, diagnostics:output?.diagnostics ?? null,
    actualTokens:output?.actualTokens ?? null, reservedTokens:output?.reservedTokens ?? null, durationMs:output?.durationMs ?? null};
});
const summary = {case:report.case,model:report.model,rows,comparable:rows.every(r=>r.status==="已评分"),
  note:"0–4 分锚点：0 相反/虚构，1 重大遗漏，2 部分满足，3 满足，4 满足且有明确反证与可复现行动。费用以供应商账单为准。"};
writeFileSync(path.join(directory,"summary.json"),JSON.stringify(summary,null,2));
console.log(JSON.stringify(summary,null,2));
