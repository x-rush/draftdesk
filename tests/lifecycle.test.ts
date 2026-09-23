import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,cpSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {Store} from '../core/store';
import {scheduleTick,runJob} from '../core/pipeline';
import {plan} from './fixtures';
import type {Job} from '../core/schema';

test('30个逻辑日：重复轮询与每日重开数据库，不重复入队；失败不自动重试',async()=>{
 const dir=mkdtempSync(path.join(tmpdir(),'dd-lifecycle-'));let db=new Store(dir);
 try{
  db.put('config','main',{...db.config(),apiKey:'test-only-never-sent'});
  db.put('plans',plan.id,{...plan,scheduleEnabled:true,dailyTime:'01:00'});
  for(let day=1;day<=30;day++){
   const date=new Date(Date.UTC(2026,9,day,18)); // Shanghai next day 02:00
   for(let i=0;i<20;i++)scheduleTick(db,date);
   assert.equal(db.list('jobs').length,day);
   const job=db.claim()!;assert.ok(job);
   await runJob(db,job,{collect:async()=>({evidence:[],warnings:day%5===0?['模拟来源失败']:[],searches:0}),structured:(async()=>{throw Error('不应调用模型')}) as any});
   assert.equal(db.get<Job>('jobs',job.id)?.state,day%5===0?'failed':'completed');
   db.close();db=new Store(dir);scheduleTick(db,date);assert.equal(db.list('jobs').length,day);
  }
  assert.equal(db.list<Job>('jobs').filter(j=>j.state==='failed').length,6);
  assert.equal(db.list<Job>('jobs').reduce((n,j)=>n+j.calls,0),0);
 }finally{db.close();rmSync(dir,{recursive:true,force:true});}
});

test('时区边界、停机跨日仅补当天、过期租约失败后队列继续、冷备恢复',()=>{
 const dir=mkdtempSync(path.join(tmpdir(),'dd-recovery-')),backup=mkdtempSync(path.join(tmpdir(),'dd-backup-'));let db=new Store(dir);
 try{
  db.put('config','main',{...db.config(),apiKey:'test-only'});
  db.put('plans',plan.id,{...plan,scheduleEnabled:true,dailyTime:'01:00'});
  scheduleTick(db,new Date('2026-10-01T16:59:00Z'));assert.equal(db.list('jobs').length,0);
  scheduleTick(db,new Date('2026-10-01T17:00:00Z'));assert.equal(db.list('jobs').length,1);
  const interrupted=db.claim()!;db.patchJob(interrupted.id,{leaseUntil:Date.now()-1});
  db.close();db=new Store(dir);db.claim();assert.equal(db.get<Job>('jobs',interrupted.id)?.state,'failed');
  scheduleTick(db,new Date('2026-10-08T18:00:00Z'));assert.equal(db.list('jobs').length,2);
  const next=db.claim()!;assert.notEqual(next.id,interrupted.id);
  db.patchJob(next.id,{state:'completed'});
  const expected=db.list('jobs');db.close();cpSync(dir,backup,{recursive:true});db=new Store(backup);
  assert.deepEqual(db.list('jobs'),expected);
  scheduleTick(db,new Date('2026-10-08T20:00:00Z'));assert.equal(db.list('jobs').length,2);
 }finally{db.close();rmSync(dir,{recursive:true,force:true});rmSync(backup,{recursive:true,force:true});}
});
