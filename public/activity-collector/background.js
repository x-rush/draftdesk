const allowed=url=>{try{const u=new URL(url);return u.protocol==='https:'&&(
 u.hostname==='www.bilibili.com'&&u.pathname.startsWith('/blackboard/era/')||
 u.hostname==='cp.kuaishou.com'&&u.pathname.startsWith('/creative/')
);}catch{return false;}};
const watches=new Map();
const activityPages={哔哩哔哩:'https://www.bilibili.com/blackboard/activity-list.html?page=1',抖音:'https://creator.douyin.com/creator-micro/creative-guidance/calendar',快手:'https://cp.kuaishou.com/creative/activity-calendar',小红书:'https://creator.xiaohongshu.com/new/events'};
const activityCards={哔哩哔哩:'h2 a[href*="/blackboard/era/"]',抖音:'.douyin-creator-common-calendar-event-item',快手:'.list_item',小红书:'.card-box'};
async function saveCollectionState(platform,value){const {draftdeskActivityRuns={}}=await chrome.storage.local.get('draftdeskActivityRuns');await chrome.storage.local.set({draftdeskActivityRuns:{...draftdeskActivityRuns,[platform]:{...value,platform}}});}
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
 if(message?.type==='draftdesk:start-collection'){
  if(!activityPages[message.platform]||!Number.isInteger(message.tabId)||message.tabId<1){respond({ok:false,error:'请选择支持的平台和浏览器标签页'});return false;}
  startCollection(message).then(()=>respond({ok:true})).catch(error=>respond({ok:false,error:error.message}));return true;
 }
 if(message?.type==='draftdesk:read-xhs-frame'){
  (async()=>{
   if(!sender.tab?.id||!sender.url?.startsWith('https://creator.xiaohongshu.com/'))throw Error('请在小红书创作者中心读取活动详情');
   const expected=new URL(message.url);
   if(expected.protocol!=='https:'||expected.hostname!=='fe.xiaohongshu.com'||!expected.pathname.startsWith('/ditto/vincent/'))throw Error('只允许读取小红书官方活动规则嵌入页');
   const results=await chrome.scripting.executeScript({target:{tabId:sender.tab.id,allFrames:true},func:()=>({url:location.href,text:(document.querySelector('main,article,#app')||document.body)?.innerText?.slice(0,12000)||''})});
   const frame=results.map(x=>x.result).find(x=>x?.url===expected.href);
   if(!frame?.text||frame.text.trim().length<100)throw Error('小红书官方规则嵌入页尚未加载或无可读正文');
   return frame;
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
