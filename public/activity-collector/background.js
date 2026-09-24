const allowed=url=>{try{const u=new URL(url);return u.protocol==='https:'&&(
 u.hostname==='www.bilibili.com'&&u.pathname.startsWith('/blackboard/era/')||
 u.hostname==='cp.kuaishou.com'&&u.pathname.startsWith('/creative/')
);}catch{return false;}};
const watches=new Map();
chrome.tabs.onCreated.addListener(tab=>{for(const watch of watches.values())if(!watch.tabId&&tab.openerTabId===watch.openerTabId)watch.tabId=tab.id;});
function waitComplete(id,timeout=15000){return new Promise((resolve,reject)=>{const timer=setTimeout(()=>{chrome.tabs.onUpdated.removeListener(handler);reject(Error('详情页加载超时'));},timeout);const handler=(tabId,info)=>{if(tabId===id&&info.status==='complete'){clearTimeout(timer);chrome.tabs.onUpdated.removeListener(handler);resolve();}};chrome.tabs.onUpdated.addListener(handler);chrome.tabs.get(id).then(tab=>{if(tab.status==='complete'){clearTimeout(timer);chrome.tabs.onUpdated.removeListener(handler);resolve();}}).catch(reject);});}
async function readTab(tabId){await waitComplete(tabId);const tab=await chrome.tabs.get(tabId);if(!allowed(tab.url))throw Error('详情页离开官方活动域名');const [{result}]=await chrome.scripting.executeScript({target:{tabId},func:()=>{const clean=s=>(s||'').replace(/\s+/g,' ').trim();const root=document.querySelector('main,article,.activity-detail,.activity_detail,.activity-content,#app')||document.body;return {url:location.href,title:clean(document.querySelector('h1,h2')?.textContent)||document.title,text:clean(root.innerText).slice(0,12000)};}});return result;}
chrome.runtime.onMessage.addListener((message,sender,respond)=>{
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
