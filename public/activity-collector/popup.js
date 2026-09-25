const $=id=>document.getElementById(id);
let capturedAt;
function allowed(value){try{const u=new URL(value);return u.protocol==='https:'&&!u.username&&!u.password&&['bilibili.com','douyin.com','douyinstatic.com','kuaishou.com','xiaohongshu.com'].some(d=>u.hostname===d||u.hostname.endsWith('.'+d));}catch{return false;}}
// Runs only in the active official tab. No cookies, storage or network responses are read.
function collectPage(){
 const host=location.hostname,clean=s=>(s||'').replace(/\s+/g,' ').trim();
 const selected=clean(window.getSelection()?.toString());
 let title='',text='',url=location.href,mode='selected';
 if(host.endsWith('creator.douyin.com')){
  const dialog=document.querySelector('[role="dialog"]');
  if(dialog){const lines=dialog.innerText.split('\n').map(clean).filter(Boolean);title=lines[0]||'';text=lines.filter(x=>x!=='去参与'&&x!=='close').join('\n');mode='抖音弹窗';}
 }else if(host.endsWith('creator.xiaohongshu.com')){
  const detail=document.querySelector('.detail .info');
  if(detail){title=clean(detail.querySelector('.title')?.textContent);text=detail.innerText;const frame=document.querySelector('.detail iframe[src]');if(frame&&/^https:\/\/fe\.xiaohongshu\.com\/ditto\/vincent\//.test(frame.src))url=frame.src;mode='小红书侧层';}
 }else if(host.endsWith('cp.kuaishou.com')){
  // "去领取" is an enrollment action and is never clicked.
  const detail=document.querySelector('[role="dialog"], .activity_detail, .activity-detail');
  if(detail){text=detail.innerText;title=clean(detail.querySelector('h1,h2,.title')?.textContent);mode='快手详情';}
 }else if(host.endsWith('bilibili.com')){
  if(!location.pathname.includes('activity-list')){title=clean(document.querySelector('h1')?.textContent)||document.title;text=clean(document.querySelector('main,article,.activity-content')?.innerText);mode='B站详情';}
 }
 if(selected.length>=50){text=selected;mode='选中文字';}
 if(!title)title=document.title;
 return {title,url,text:clean(text),mode};
}
function scanPage(){
 const host=location.hostname,clean=s=>(s||'').replace(/\s+/g,' ').trim();
 let items=[];
 if(host.endsWith('bilibili.com'))items=[...document.querySelectorAll('h2 a[href*="/blackboard/era/"]')].map(a=>({title:clean(a.textContent),detail:a.href}));
 else if(host.endsWith('creator.xiaohongshu.com'))items=[...document.querySelectorAll('.card-box')].map(e=>({title:clean(e.querySelector('.title')?.textContent),detail:clean(e.querySelector('.desc')?.textContent)}));
 else if(host.endsWith('cp.kuaishou.com'))items=[...document.querySelectorAll('.list_item')].map(e=>({title:clean(e.querySelector('.list_item_main_title')?.textContent),detail:clean(e.querySelector('.list_item_main_breif')?.textContent)}));
 else if(host.endsWith('creator.douyin.com'))items=[...document.querySelectorAll('.douyin-creator-common-calendar-event-item')].map(e=>({title:clean(e.textContent),detail:''}));
 const seen=new Set();items=items.filter(e=>{if(!e.title||seen.has(e.title))return false;seen.add(e.title);return true;});
 const pattern=/AI|AIGC|人工智能|智能|编程|代码|工具|科技|数码|创作|开发|Vibe|赛博/i;
 return {total:items.length,candidates:items.filter(x=>pattern.test(x.title+' '+x.detail)).slice(0,20)};
}
const activityPages={哔哩哔哩:'https://www.bilibili.com/blackboard/activity-list.html?page=1',抖音:'https://creator.douyin.com/creator-micro/creative-guidance/calendar',快手:'https://cp.kuaishou.com/creative/activity-calendar',小红书:'https://creator.xiaohongshu.com/new/events'};
async function activeTab(){const [tab]=await chrome.tabs.query({active:true,currentWindow:true});if(!tab||!allowed(tab.url)||!platformName(tab.url))throw Error('请先打开支持的官方创作者中心，或在下方选择平台。');return tab;}
function platformName(value){try{const host=new URL(value).hostname;return ['www.bilibili.com','member.bilibili.com'].includes(host)?'哔哩哔哩':host==='creator.douyin.com'?'抖音':host==='cp.kuaishou.com'?'快手':host==='creator.xiaohongshu.com'?'小红书':'';}catch{return '';}}
function isActivityPage(value,platform){try{const current=new URL(value),target=new URL(activityPages[platform]);return current.protocol==='https:'&&current.hostname===target.hostname&&current.pathname===target.pathname;}catch{return false;}}
let currentBundle;
function download(data,name){const u=URL.createObjectURL(new Blob([JSON.stringify(data,null,2)],{type:'application/json'}));const a=document.createElement('a');a.href=u;a.download=name;a.click();setTimeout(()=>URL.revokeObjectURL(u),1000);}
async function refreshRun(){
 const [tab]=await chrome.tabs.query({active:true,currentWindow:true});
 const platform=platformName(tab?.url),onActivityPage=platform&&isActivityPage(tab.url,platform);
 const {draftdeskActivityRuns={}}=await chrome.storage.local.get('draftdeskActivityRuns');
 const run=draftdeskActivityRuns[platform];
 $('pageState').className='page-state'+(platform?(onActivityPage?'':' needs-page'):' unsupported');
 $('platformPill').textContent=platform||'未识别到创作者中心';
 $('pageStatus').textContent=onActivityPage?'已在活动页，可以开始采集。':platform?'当前是创作者中心的其他页面，点击下方按钮会打开活动中心并开始采集。':'请选择下方平台，在新标签页登录后打开扩展采集。';
 $('auto').textContent=run?.state==='running'?'正在采集…':onActivityPage?`采集${platform}当前活动页`:platform?`打开${platform}活动页并采集`:'先选择一个平台';
 $('auto').disabled=!platform||run?.state==='running';
 $('runStatus').textContent=run?`${platform}：${run.progress||run.state}`:platform?`${platform}尚无采集结果`:'选择平台后显示采集进度';
 currentBundle=run?.state==='completed'?run.bundle:null;
 $('downloadBatch').disabled=!currentBundle;
}
setInterval(()=>void refreshRun(),1500);void refreshRun();
$('auto').onclick=async()=>{try{const tab=await activeTab();const platform=platformName(tab.url);const keywords=$('keywords').value.split(/[,，\n]/).map(x=>x.trim()).filter(Boolean).slice(0,20);const maxPages=Math.max(1,Math.min(5,Number($('maxPages').value)||2));$('auto').disabled=true;$('runStatus').textContent=`${platform}：正在准备官方活动页…`;const result=await chrome.runtime.sendMessage({type:'draftdesk:start-collection',tabId:tab.id,platform,config:{keywords,maxPages,maxItems:100}});if(!result?.ok)throw Error(result?.error||'未能启动采集');await refreshRun();}catch(e){$('auto').disabled=false;$('runStatus').textContent=e.message;}};
for(const button of document.querySelectorAll?.('[data-platform]')||[]){button.onclick=()=>chrome.tabs.create({url:activityPages[button.dataset.platform],active:true});}
$('downloadBatch').onclick=()=>{if(currentBundle)download(currentBundle,'draftdesk-activities-batch.json');};
$('scan').onclick=async()=>{try{const tab=await activeTab();const [{result}]=await chrome.scripting.executeScript({target:{tabId:tab.id},func:scanPage});$('candidates').textContent=`当前页发现 ${result.total} 个不重复活动；关键词初筛 ${result.candidates.length} 个：\n`+result.candidates.map(x=>`• ${x.title}${x.detail?' — '+x.detail:''}`).join('\n');}catch(e){$('status').textContent=e.message;}};
$('read').onclick=async()=>{try{$('save').disabled=true;const tab=await activeTab();const [{result:data}]=await chrome.scripting.executeScript({target:{tabId:tab.id},func:collectPage});if(data.text.length<50)throw Error('当前页没有可验证的完整规则。请打开具体活动详情并展开规则；若规则在嵌入页中，请选中规则正文后重试。');if(data.text.length>12000)throw Error('正文超过12000字，请选中活动规则的关键段落后重试。');$('title').value=data.title;$('url').value=data.url;$('text').value=data.text;capturedAt=new Date().toISOString();$('save').disabled=false;$('status').textContent=`已从${data.mode}读取。请核对年份、奖励与资格；列表摘要不等于完整规则。`;}catch(e){$('status').textContent=e.message;}};
$('save').onclick=()=>{if($('text').value.trim().length<50||$('title').value.trim().length<3){$('status').textContent='标题至少3字，正文至少50字。';return;}const data={schemaVersion:'draftdesk.activity-page.v1',title:$('title').value,url:$('url').value,text:$('text').value,capturedAt};download(data,'draftdesk-activity.json');};
