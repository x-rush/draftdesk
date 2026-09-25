import test from "node:test";
import assert from "node:assert/strict";
import {mkdtempSync,rmSync} from "node:fs";
import {tmpdir} from "node:os";
import path from "node:path";
import {requestModel} from "../core/model";
import {Store} from "../core/store";
import type {Job} from "../core/schema";

// Regression: completed calls retained the entire worst-case reservation,
// exhausting a task's cap even when the provider returned much lower usage.
test("reported model usage settles a conservative reservation without weakening preflight",async()=>{
 const dir=mkdtempSync(path.join(tmpdir(),"dd-model-budget-"));
 const db=new Store(dir);
 try{
  db.put("config","main",{...db.config(),apiKey:"test-only",dailyTokenLimit:30000});
  const job=db.enqueue("trend-radar")!;
  const fakeFetch=(async()=>new Response(JSON.stringify({choices:[{message:{content:"ok"}}],usage:{total_tokens:1000}}),{status:200})) as typeof fetch;
  const result=await requestModel(db,[{role:"user",content:"test"}],{signal:new AbortController().signal,jobId:job.id,fetch:fakeFetch,maxOutputTokens:1000});
  assert.ok(result.reservation>1500);
  assert.equal(db.dayBudget().reserved,1500);
  assert.equal(db.get<Job>("jobs",job.id)?.reservedTokens,1500);
  assert.equal(db.get<Job>("jobs",job.id)?.actualTokens,1000);
  await requestModel(db,[{role:"user",content:"test"}],{signal:new AbortController().signal,jobId:job.id,
   fetch:(async()=>new Response(JSON.stringify({choices:[{message:{content:"ok"}}]}),{status:200})) as typeof fetch,maxOutputTokens:1000});
  assert.equal(db.dayBudget().reserved,1500+result.reservation);
 }finally{db.close();rmSync(dir,{recursive:true,force:true});}
});
