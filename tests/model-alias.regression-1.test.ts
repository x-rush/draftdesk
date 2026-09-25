import test from "node:test";
import assert from "node:assert/strict";
import {mkdtempSync,rmSync} from "node:fs";
import {tmpdir} from "node:os";
import path from "node:path";
import {structured} from "../core/model";
import {researchClusterSchema} from "../core/schema";
import {Store} from "../core/store";
import {evidence} from "./fixtures";

// Regression: a non-activity research stage used full IDs in its schema while
// activity stages used short IDs in their evidence payload.
test("all research kinds show one consistent set of short evidence IDs",async()=>{
 const dir=mkdtempSync(path.join(tmpdir(),"dd-model-alias-"));
 const db=new Store(dir);
 try{
  db.put("config","main",{...db.config(),apiKey:"test-only-no-network"});
  const job=db.enqueue("trend-radar")!;
  const request=(async(_db:unknown,messages:{content:string}[])=>{
   const payload=JSON.parse(messages[1].content);
   assert.equal(payload.evidence[0].id,"ref_1");
   assert.equal(payload.evidence[1].id,"ref_2");
   assert.match(messages[0].content,/短编号 ref_1, ref_2/);
   assert.doesNotMatch(messages[0].content,/ev-one/);
   return {text:JSON.stringify({clusters:[{label:"AI 视频",summary:"同一主题的两条资料",evidenceIds:["ref_1","ref_2"],contradictions:[],missing:[]}],excluded:[]}),usage:0,reservation:0};
  }) as any;
  const result=await structured(db,job,"test",{evidence},researchClusterSchema(evidence.map(e=>e.id)),new AbortController().signal,request);
  assert.deepEqual(result.clusters[0].evidenceIds,evidence.map(e=>e.id));
 }finally{db.close();rmSync(dir,{recursive:true,force:true});}
});
