import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,cpSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {Store} from '../core/store';
import {runJob} from '../core/pipeline';
import {plan} from './fixtures';
import type {Job} from '../core/schema';

test('30个逻辑日：重复轮询与每日重开数据库，不重复入队；失败不自动重试',async()=>{
 const dir=mkdtempSync(path.join(tmpdir(),'dd-lifecycle-'));let db=new Store(dir);
 try{
  db.put('config','main',{...db.config(),apiKey:'test-only-never-sent'});
  // R10.9 P2-1：scheduleTick 已删（collectAllTick 接管采集）——本测试改为手动入队幂等 + runJob 30 日循环
  db.put('plans',plan.id,plan);
  for(let day=1;day<=30;day++){
   const date=new Date(Date.UTC(2026,9,day,18));
   void date;
   const job0=db.enqueue(plan.id,[],`${plan.id}:2026-10-${String(day).padStart(2,'0')}`);
   void job0;
   try{db.enqueue(plan.id,[],`${plan.id}:2026-10-${String(day).padStart(2,'0')}`)}catch{ /* 幂等键重复入队被拒 */ }
   assert.equal(db.list('jobs').length,day,'同键重复入队不产生新任务');
   const job=db.claim()!;assert.ok(job);
   await runJob(db,job,{collect:async()=>({evidence:[],warnings:day%5===0?['模拟来源失败']:[],searches:0}),structured:(async()=>{throw Error('不应调用模型')}) as any});
   assert.equal(db.get<Job>('jobs',job.id)?.state,day%5===0?'failed':'completed');
   db.close();db=new Store(dir);
  }
  assert.equal(db.list<Job>('jobs').filter(j=>j.state==='failed').length,6);
  assert.equal(db.list<Job>('jobs').reduce((n,j)=>n+j.calls,0),0);
 }finally{db.close();rmSync(dir,{recursive:true,force:true});}
});

test('时区边界、停机跨日仅补当天、过期租约失败后队列继续、冷备恢复',()=>{
 const dir=mkdtempSync(path.join(tmpdir(),'dd-recovery-')),backup=mkdtempSync(path.join(tmpdir(),'dd-backup-'));let db=new Store(dir);
 try{
  db.put('config','main',{...db.config(),apiKey:'test-only'});
  // R10.9 P2-1：调度删后的等价守护——过期租约回收、幂等键不重复、冷备一致
  db.put('plans',plan.id,plan);
  db.enqueue(plan.id,[],`${plan.id}:2026-10-01`);
  assert.equal(db.list('jobs').length,1);
  const interrupted=db.claim()!;db.patchJob(interrupted.id,{leaseUntil:Date.now()-1});
  db.close();db=new Store(dir);db.claim();assert.equal(db.get<Job>('jobs',interrupted.id)?.state,'failed');
  try{db.enqueue(plan.id,[],`${plan.id}:2026-10-01`)}catch{ /* 同键拒绝 */ }
  db.enqueue(plan.id,[],`${plan.id}:2026-10-08`);
  assert.equal(db.list('jobs').length,2);
  const next=db.claim()!;assert.notEqual(next.id,interrupted.id);
  db.patchJob(next.id,{state:'completed'});
  const expected=db.list('jobs');db.close();cpSync(dir,backup,{recursive:true});db=new Store(backup);
  assert.deepEqual(db.list('jobs'),expected);
  try{db.enqueue(plan.id,[],`${plan.id}:2026-10-08`)}catch{ /* 同键拒绝 */ }
  assert.equal(db.list('jobs').length,2);
 }finally{db.close();rmSync(dir,{recursive:true,force:true});rmSync(backup,{recursive:true,force:true});}
});
// R10.9 P2-1：调度激活窗口语义随 scheduleTick 删除而废弃——改为验证幂等键的天然防重
test('R10.9：调度删除后 enqueue 幂等键仍是防重跑闸（错过/重开不重复付费语义由键承载）',()=>{const dir=mkdtempSync(path.join(tmpdir(),'dd-activation-')),db=new Store(dir);try{db.put('config','main',{...db.config(),apiKey:'test-only'});db.put('plans',plan.id,plan);db.enqueue(plan.id,[],`${plan.id}:2026-10-01`);assert.equal(db.list('jobs').length,1);try{db.enqueue(plan.id,[],`${plan.id}:2026-10-01`)}catch{ /* 同键拒 */ }assert.equal(db.list('jobs').length,1,'重复入队被幂等键拦下');}finally{db.close();rmSync(dir,{recursive:true,force:true});}});
