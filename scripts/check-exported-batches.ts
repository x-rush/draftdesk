import {readFileSync,writeFileSync} from "node:fs";
import {activityBatchSchema} from "../core/activity-batch.ts";

const home=process.env.USERPROFILE||"";
const dir=home.replace(/\\/g,"/")+"/Downloads";
const files=["bilibili.json","douyin.json","kuaishou.json","rednote.json"];
const out=[];
for(const f of files){
  let raw; try{ raw=readFileSync(`${dir}/${f}`,"utf8"); }catch(e){ out.push({file:f,error:"读取失败:"+String(e)}); continue; }
  let parsed; try{ parsed=JSON.parse(raw); }catch(e){ out.push({file:f,error:"JSON 解析失败:"+String(e)}); continue; }
  const r=activityBatchSchema.safeParse(parsed);
  if(r.success){
    out.push({file:f,ok:true,platform:r.data.platform,items:r.data.items.length,visibleTotal:r.data.coverage?.visibleTotal??"(missing)",warnings:r.data.warnings.length});
  }else{
    out.push({file:f,ok:false,issues:r.error.issues.map(i=>`${i.path.join(".")}: ${i.message} (${i.code})`)});
  }
}
writeFileSync(home+"\\AppData\\Local\\Temp\\dd-schema-check.json",JSON.stringify(out,null,1),"utf8");
console.log("done");
