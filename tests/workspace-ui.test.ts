import test from "node:test";
import assert from "node:assert/strict";
import {mkdtempSync,rmSync} from "node:fs";
import {tmpdir} from "node:os";
import path from "node:path";
import {Store} from "../core/store";
import {topic} from "./fixtures";
import {readWorkspaceLocation,draftChanges,newlyFinished} from "../core/workspace-ui";
test("网址恢复筛选、页码与任务，非法参数退回默认",()=>{
 const v=readWorkspaceLocation("?view=library&page=3&q=AI&creation=writing&quality=review&jobId=j1");
 assert.equal(v.view,"library");assert.equal(v.page,3);assert.equal(v.q,"AI");assert.equal(v.creation,"writing");assert.equal(v.jobId,"j1");
 const bad=readWorkspaceLocation("?view=unknown&page=-9&kind=x&creation=anything");assert.equal(bad.view,"discover");assert.equal(bad.page,1);assert.equal(bad.kind,"all");assert.equal(bad.creation,"all");
});
test("更新差异显示内容字段，不混入进度与权限元数据",()=>{assert.deepEqual(draftChanges({title:"旧",revision:1},{title:"新",revision:2,creationStatus:"published"}),["title"]);});
test("完成提示识别状态转换与快速任务，历史任务不重复提示",()=>{
 const at=Date.now(), jobs=[{id:"a",state:"completed",name:"研究",total:2,review:1},{id:"b",state:"failed",name:"快速任务",total:0,review:0,createdAt:new Date(at).toISOString()},{id:"c",state:"completed",name:"旧任务",total:0,review:0,createdAt:"2020-01-01"}];
 assert.deepEqual(newlyFinished(jobs,new Map([["a","running"]]),at).map(j=>j.id),["a","b"]);
 assert.equal(newlyFinished(jobs,new Map(jobs.map(j=>[j.id,j.state])),at).length,0);
});
test("创作进度独立于证据质量和发布权限，编辑保留进度并拒绝过期更新",()=>{
 const dir=mkdtempSync(path.join(tmpdir(),"dd-ux-")),db=new Store(dir);
 try{
  const a=db.saveArtifact(topic,"job-one","review",["待核实"]);
  const updated=db.updateArtifact({id:a.id,revision:a.revision,creationStatus:"published"});
  assert.equal(updated.quality,"review");assert.equal(updated.visibility,"private");assert.equal(updated.saved,true);assert.equal(updated.creationStatus,"published");
  assert.throws(()=>db.updateArtifact({id:a.id,revision:a.revision,creationStatus:"writing"}));
  const edited=db.updateArtifact({id:a.id,revision:updated.revision,draft:{...topic,title:"讨论后的新标题"}});assert.equal(edited.creationStatus,"published");
  const snapshot=db.snapshot(new URLSearchParams("page=1&view=library&creation=published&jobId=job-one")) as any;assert.equal(snapshot.artifacts.length,1);
  assert.equal((db.snapshot(new URLSearchParams("page=1&creation=writing")) as any).artifacts.length,0);
  assert.equal((db.snapshot(new URLSearchParams("page=1&jobId=other")) as any).artifacts.length,0);
 }finally{db.close();rmSync(dir,{recursive:true,force:true});}
});
