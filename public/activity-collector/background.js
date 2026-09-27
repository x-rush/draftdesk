const allowed=url=>{try{const u=new URL(url);return u.protocol==='https:'&&(
 u.hostname==='www.bilibili.com'&&u.pathname.startsWith('/blackboard/era/')||
 u.hostname==='cp.kuaishou.com'&&u.pathname.startsWith('/creative/')
);}catch{return false;}};
const watches=new Map();
const sending=new Set();
function within(promise,ms,message){
 let timer;
 return Promise.race([promise,new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error(message)),ms);})]).finally(()=>clearTimeout(timer));
}
function localWorkbench(value){
 const url=new URL(value||'http://127.0.0.1:5173');
 if(url.protocol!=='http:'||!['127.0.0.1','localhost'].includes(url.hostname)||url.username||url.password||url.pathname!=='/'||url.search||url.hash)throw Error('工作台地址只能是本机 http://127.0.0.1:端口 或 http://localhost:端口');
 return url.origin;
}
const activityPages={哔哩哔哩:'https://www.bilibili.com/blackboard/activity-list.html?page=1',抖音:'https://creator.douyin.com/creator-micro/creative-guidance/calendar',快手:'https://cp.kuaishou.com/creative/activity-calendar',小红书:'https://creator.xiaohongshu.com/new/events'};
const activityCards={哔哩哔哩:'h2 a[href*="/blackboard/era/"]',抖音:'.douyin-creator-common-calendar-event-item',快手:'.list_item',小红书:'.card-box'};
async function saveCollectionState(platform,value){const {draftdeskActivityRuns={}}=await chrome.storage.local.get('draftdeskActivityRuns');await chrome.storage.local.set({draftdeskActivityRuns:{...draftdeskActivityRuns,[platform]:{...value,platform}}});}
async function updateSyncState(platform,patch){
 const {draftdeskActivityRuns={}}=await chrome.storage.local.get('draftdeskActivityRuns');
 if(!draftdeskActivityRuns[platform])return;
 await chrome.storage.local.set({draftdeskActivityRuns:{...draftdeskActivityRuns,[platform]:{...draftdeskActivityRuns[platform],...patch}}});
}
async function workbenchTab(base){
 const tabs=await chrome.tabs.query({});
 const existing=tabs.find(tab=>{try{return new URL(tab.url).origin===base;}catch{return false;}});
 const tab=existing||await chrome.tabs.create({url:base+'/?view=activities',active:false});
 await waitComplete(tab.id,8000);
 return tab.id;
}
async function requestFromWorkbench(tabId,base,path,body){
 const key=crypto.randomUUID(),target={tabId};
 const [{result:started}]=await within(chrome.scripting.executeScript({target,world:'MAIN',func:(expectedOrigin,requestPath,payload,id)=>{
  if(location.origin!==expectedOrigin)return {ok:false,error:'工作台标签页已离开配置的本机地址'};
  const requests=window.__draftdeskLocalRequests ||= Object.create(null);
  requests[id]={pending:true};
  const controller=new AbortController();
  const timer=setTimeout(()=>controller.abort(),10000);
  const options=payload===null?{cache:'no-store',signal:controller.signal}:{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(payload),signal:controller.signal};
  fetch(requestPath,options).then(async response=>{
   const data=await response.json();
   requests[id]=response.ok?{ok:true,...data}:{ok:false,error:data.error||`工作台返回 HTTP ${response.status}`};
  }).catch(error=>{requests[id]={ok:false,error:error.name==='AbortError'?'本机工作台 10 秒内未响应':error.message||'无法连接工作台'};}).finally(()=>clearTimeout(timer));
  return {ok:true};
 },args:[base,path,body,key]}),3000,'工作台标签页没有响应，无法开始上传');
 if(!started?.ok)throw Error(started?.error||'无法在本机工作台打开上传请求');
 const deadline=Date.now()+12000;
 while(Date.now()<deadline){
  const [{result}]=await within(chrome.scripting.executeScript({target,world:'MAIN',func:id=>{
   const state=window.__draftdeskLocalRequests?.[id];
   if(state&&!state.pending)delete window.__draftdeskLocalRequests[id];
   return state||{ok:false,error:'工作台页面已刷新，上传结果丢失'};
  },args:[key]}),3000,'工作台标签页没有响应，无法读取上传结果');
  if(!result?.pending)return result;
  await new Promise(resolve=>setTimeout(resolve,400));
 }
 throw Error('本机工作台上传超过 12 秒，请检查连接后重试');
}
async function sendBatch(platform,automatic=false){
 if(sending.has(platform))return {ok:false,error:'该平台的结果正在发送'};
 sending.add(platform);
 try{
  const settings=await chrome.storage.local.get(['draftdeskLocalUrl','draftdeskAutoSync','draftdeskActivityRuns']);
  if(automatic&&settings.draftdeskAutoSync===false)return {ok:true,skipped:true};
  const run=settings.draftdeskActivityRuns?.[platform];
  if(run?.state!=='completed'||!run.bundle)throw Error('该平台还没有已完成的采集结果');
  const base=localWorkbench(settings.draftdeskLocalUrl);
  await updateSyncState(platform,{syncState:'sending',syncError:'',syncStartedAt:new Date().toISOString()});
  const tabId=await workbenchTab(base);
  const result=await requestFromWorkbench(tabId,base,'/api/v1/activity-batches',run.bundle);
  if(!result?.ok)throw Error(result?.error||'工作台没有确认收到采集结果');
  await updateSyncState(platform,{syncState:'sent',syncError:'',syncRecordId:result.id,syncedAt:new Date().toISOString()});
  return {ok:true,id:result.id,count:result.count,duplicate:result.duplicate};
 }catch(error){const message=error?.message||'发送失败';await updateSyncState(platform,{syncState:'failed',syncError:message});return {ok:false,error:message};}
 finally{sending.delete(platform);}
}
async function checkWorkbench(){
 try{
  const {draftdeskLocalUrl}=await chrome.storage.local.get('draftdeskLocalUrl');
  const base=localWorkbench(draftdeskLocalUrl);
  const tabId=await workbenchTab(base);
  const result=await requestFromWorkbench(tabId,base,'/api/v1/health',null);
  return result?.ok?{ok:true}:{ok:false,error:'工作台未响应，请检查地址和 Docker 服务'};
 }catch(error){return {ok:false,error:error?.message||'无法连接工作台'};}
}
async function openWorkbench(){
 const {draftdeskLocalUrl}=await chrome.storage.local.get('draftdeskLocalUrl');
 const base=localWorkbench(draftdeskLocalUrl);
 const tabs=await chrome.tabs.query({});
 const existing=tabs.find(tab=>{try{return new URL(tab.url).origin===base;}catch{return false;}});
 if(existing){
  await chrome.tabs.update(existing.id,{active:true});
  if(existing.windowId)await chrome.windows.update(existing.windowId,{focused:true}).catch(()=>{});
  return {ok:true,opened:'existing'};
 }
 await chrome.tabs.create({url:base+'/?view=activities',active:true});
 return {ok:true,opened:'created'};
}
async function startCollection(message){
 const {platform,tabId}=message,target=activityPages[platform];
 if(!target||!Number.isInteger(tabId)||tabId<1)throw Error('请选择支持的平台和浏览器标签页');
 const tab=await chrome.tabs.get(tabId);
 const expected=new URL(target),current=new URL(tab.url);
 if(current.protocol!=='https:'||(current.hostname!==expected.hostname&&!(platform==='哔哩哔哩'&&current.hostname==='member.bilibili.com')))throw Error('请从该平台的官方创作者中心启动采集');
 const startedAt=new Date().toISOString();
 await saveCollectionState(platform,{state:'running',progress:'正在打开官方活动中心…',startedAt});
 try{
  if(current.hostname!==expected.hostname||current.pathname!==expected.pathname)await chrome.tabs.update(tabId,{url:target});
  let ready=false;
  for(let attempt=0;attempt<40;attempt++){
   await new Promise(resolve=>setTimeout(resolve,500));
   const live=await chrome.tabs.get(tabId),page=new URL(live.url||target);
   if(page.hostname!==expected.hostname||page.pathname!==expected.pathname){
    if(live.status==='complete'&&attempt>=3)throw Error('活动页跳转到了登录或其他页面；请在官方页面完成登录后重新采集。');
    continue;
   }
   if(live.status!=='complete')continue;
   try{
    const [{result}]=await chrome.scripting.executeScript({target:{tabId},func:selector=>!!document.querySelector(selector),args:[activityCards[platform]]});
    if(result){ready=true;break;}
   }catch{/* SPA 仍在加载时下一轮再试。 */}
  }
  if(!ready)throw Error('活动中心已打开，但没有加载出活动列表；请检查登录状态或刷新活动页后重试。');
  await chrome.scripting.executeScript({target:{tabId},files:['auto.js']});
  const result=await chrome.tabs.sendMessage(tabId,{type:'draftdesk:auto',config:message.config});
  if(!result?.ok)throw Error('活动页已打开，但采集器未能启动；请刷新页面后重试。');
 }catch(error){await saveCollectionState(platform,{state:'failed',progress:error.message,startedAt});throw error;}
}
chrome.tabs.onCreated.addListener(tab=>{for(const watch of watches.values())if(!watch.tabId&&tab.openerTabId===watch.openerTabId)watch.tabId=tab.id;});
function waitComplete(id,timeout=15000){return new Promise((resolve,reject)=>{const timer=setTimeout(()=>{chrome.tabs.onUpdated.removeListener(handler);reject(Error('详情页加载超时'));},timeout);const handler=(tabId,info)=>{if(tabId===id&&info.status==='complete'){clearTimeout(timer);chrome.tabs.onUpdated.removeListener(handler);resolve();}};chrome.tabs.onUpdated.addListener(handler);chrome.tabs.get(id).then(tab=>{if(tab.status==='complete'){clearTimeout(timer);chrome.tabs.onUpdated.removeListener(handler);resolve();}}).catch(reject);});}
async function readTab(tabId){await waitComplete(tabId);const tab=await chrome.tabs.get(tabId);if(!allowed(tab.url))throw Error('详情页离开官方活动域名');let result;for(let attempt=0;attempt<10;attempt++){[{result}]=await chrome.scripting.executeScript({target:{tabId},func:()=>{const clean=s=>(s||'').replace(/\s+/g,' ').trim();const root=document.querySelector('main,article,.activity-detail,.activity_detail,.activity-content,#app')||document.body;return {url:location.href,title:clean(document.querySelector('h1,h2')?.textContent)||document.title,text:clean(root.innerText).slice(0,12000)};}});if(result?.text?.length>=50)return result;await new Promise(resolve=>setTimeout(resolve,400));}throw Error('官方详情已打开，但规则正文未加载或不足 50 字');}
chrome.runtime.onMessage.addListener((message,sender,respond)=>{
 if(message?.type==='draftdesk:auto-send'||message?.type==='draftdesk:send-batch'){
  respond({ok:true,queued:true});
  void sendBatch(message.platform,message.type==='draftdesk:auto-send');
  return false;
 }
 if(message?.type==='draftdesk:send-all'){
  respond({ok:true,queued:true});
  void (async()=>{const {draftdeskActivityRuns={}}=await chrome.storage.local.get('draftdeskActivityRuns');const platforms=Object.entries(draftdeskActivityRuns).filter(([,run])=>run.state==='completed'&&run.bundle).map(([platform])=>platform);for(const platform of platforms)await sendBatch(platform);})();
  return false;
 }
 if(message?.type==='draftdesk:check-workbench'){
  checkWorkbench().then(respond);return true;
 }
 if(message?.type==='draftdesk:open-workbench'){
  openWorkbench().then(respond).catch(error=>respond({ok:false,error:error?.message||'无法打开工作台'}));return true;
 }
 if(message?.type==='draftdesk:start-collection'){
  if(!activityPages[message.platform]||!Number.isInteger(message.tabId)||message.tabId<1){respond({ok:false,error:'请选择支持的平台和浏览器标签页'});return false;}
  startCollection(message).then(()=>respond({ok:true})).catch(error=>respond({ok:false,error:error.message}));return true;
 }
 if(message?.type==='draftdesk:read-xhs-frame'){
  (async()=>{
   if(!sender.tab?.id||!sender.url?.startsWith('https://creator.xiaohongshu.com/'))throw Error('请在小红书创作者中心读取活动详情');
   const expected=new URL(message.url);
   if(expected.protocol!=='https:'||expected.hostname!=='fe.xiaohongshu.com'||!expected.pathname.startsWith('/ditto/vincent/'))throw Error('只允许读取小红书官方活动规则嵌入页');
   for(let attempt=0;attempt<10;attempt++){
    try{
     const results=await chrome.scripting.executeScript({target:{tabId:sender.tab.id,allFrames:true},func:()=>({url:location.href,text:(document.querySelector('main,article,#app')||document.body)?.innerText?.slice(0,12000)||''})});
     const frame=results.map(x=>x.result).find(x=>x?.url===expected.href);
     if(frame?.text?.trim().length>=100)return frame;
    }catch{/* The drawer iframe may still be navigating; retry only within the bounded wait. */}
    await new Promise(resolve=>setTimeout(resolve,400));
   }
   throw Error('小红书官方规则嵌入页等待 4 秒后仍无可读正文');
  })().then(result=>respond({ok:true,result})).catch(e=>respond({ok:false,error:e.message}));return true;
 }
 if(message?.type==='draftdesk:read-url'){
  (async()=>{if(!allowed(message.url))throw Error('只允许打开 B站或快手的官方活动详情');const tab=await chrome.tabs.create({url:message.url,active:false});try{return await readTab(tab.id);}finally{await chrome.tabs.remove(tab.id).catch(()=>{});}})().then(result=>respond({ok:true,result})).catch(e=>respond({ok:false,error:e.message}));return true;
 }
 if(message?.type==='draftdesk:watch-tab'){
  const id=crypto.randomUUID();watches.set(id,{openerTabId:sender.tab?.id,tabId:null,at:Date.now()});respond({ok:true,id});return false;
 }
 if(message?.type==='draftdesk:finish-watch'){
  (async()=>{const watch=watches.get(message.id);watches.delete(message.id);if(!watch||Date.now()-watch.at>20000||!watch.tabId)throw Error('没有打开可读取的官方详情页');try{return await readTab(watch.tabId);}finally{await chrome.tabs.remove(watch.tabId).catch(()=>{});}})().then(result=>respond({ok:true,result})).catch(e=>respond({ok:false,error:e.message}));return true;
 }
});
