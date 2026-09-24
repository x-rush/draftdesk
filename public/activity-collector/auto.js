// Runs only after the user presses Collect on an official activity page.
if (!globalThis.__draftdeskActivityCollector) {
 globalThis.__draftdeskActivityCollector = true;
 const clean = s => (s || '').replace(/\s+/g, ' ').trim();
 const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
 const platform = location.hostname === 'www.bilibili.com' ? '哔哩哔哩' : location.hostname === 'creator.douyin.com' ? '抖音' : location.hostname === 'cp.kuaishou.com' ? '快手' : location.hostname === 'creator.xiaohongshu.com' ? '小红书' : '';
 function deadline(value, yearHint) {
  const s = clean(value);
  const all = [...s.matchAll(/(?:(20\d{2})[年/.\-])?\s*(\d{1,2})[月/.\-](\d{1,2})\s*日?/g)];
  if (!all.length) return null;
  const last = all.at(-1), first = all[0];
  let year = Number(last[1] || first[1] || yearHint || new Date().getFullYear());
  if (!last[1] && !first[1] && all.length > 1 && Number(last[2]) < Number(first[2])) year++;
  const month = Number(last[2]), day = Number(last[3]);
  const end = new Date(Date.UTC(year, month - 1, day, 15, 59, 59));
  if (end.getUTCFullYear() !== year || end.getUTCMonth() !== month - 1 || end.getUTCDate() !== day) return null;
  return {endsAt: end.toISOString(), inferred: !last[1] && !first[1]};
 }
 function make(title,url,text,dateText,completeness,yearHint) {
  const d = deadline(dateText,yearHint);
  return {platform,title:clean(title).slice(0,300),url,text:clean(text).slice(0,12000),dateText:clean(dateText).slice(0,200),...(d ? {endsAt:d.endsAt} : {}),completeness,capturedAt:new Date().toISOString(),inferredYear:!!d?.inferred};
 }
 async function run(config) {
  if (!platform) throw Error('请在四个平台的官方创作活动页运行');
  const keywords = config.keywords.map(clean).filter(Boolean).slice(0,20);
  const maxPages = Math.max(1,Math.min(Number(config.maxPages)||2,5));
  const maxItems = Math.max(1,Math.min(Number(config.maxItems)||20,40));
  const items = [], warnings = [], seen = new Set();
  const matched = text => !keywords.length || keywords.some(k=>text.toLocaleLowerCase().includes(k.toLocaleLowerCase()));
  const progress = async message => chrome.storage.local.set({draftdeskActivityRun:{state:'running',progress:message,startedAt:config.startedAt}});
  const add = item => {
   if (!item?.title || !item.url || seen.has(`${item.url}|${item.title}`)) return;
   seen.add(`${item.url}|${item.title}`);
   if (!item.endsAt) {warnings.push(`${item.title}：未获得可确认的截止日期，未导入`);return;}
   if (Date.parse(item.endsAt) < Date.now()) return;
   if (!matched(`${item.title} ${item.text}`)) return;
   if (item.inferredYear) warnings.push(`${item.title}：页面仅写月日，年份按当前日历推定，请在分析前核对`);
   delete item.inferredYear;
   items.push(item);
  };
  if (platform === '哔哩哔哩') {
   for (let page=1;page<=maxPages && items.length<maxItems;page++) {
    await progress(`B站列表 ${page}/${maxPages}`);
    const response=await fetch(`/blackboard/activity-list.html?page=${page}`,{credentials:'same-origin'});
    if (!response.ok) {warnings.push(`B站第 ${page} 页 HTTP ${response.status}`);break;}
    const doc=new DOMParser().parseFromString(await response.text(),'text/html');
    const anchors=[...doc.querySelectorAll('h2 a[href*="/blackboard/era/"]')];
    if (!anchors.length) {warnings.push(`B站第 ${page} 页未解析到活动卡片`);break;}
    for (const a of anchors) {
     if (items.length>=maxItems) break;
     const title=clean(a.textContent), url=new URL(a.getAttribute('href'),location.origin).href;
     if (seen.has(`${url}|${title}`)) continue;
     const card=a.closest('li,article,.activity-item,.activity-card')||a.parentElement?.parentElement;
     const dateText=clean(card?.textContent);
     if (!deadline(dateText) || !matched(title)) continue;
     let detail=null;
     try {const res=await chrome.runtime.sendMessage({type:'draftdesk:read-url',url});if (res.ok) detail=res.result;else warnings.push(`${title}：${res.error}`);}catch(e){warnings.push(`${title}：详情读取失败 ${e.message}`);}
     add(make(title,url,detail?.text||dateText,dateText,detail?.text?.length>=50?'detail':'summary'));
     await pause(350);
    }
   }
  } else if (platform === '小红书') {
   for (let page=1;page<=maxPages && items.length<maxItems;page++) {
    await progress(`小红书列表 ${page}/${maxPages}`);
    const cards=[...document.querySelectorAll('.card-box')];
    if (!cards.length){warnings.push('小红书没有读到活动卡片，请确认已登录并打开活动中心');break;}
    for (const card of cards) {
     if (items.length>=maxItems) break;
     const title=clean(card.querySelector('.title')?.textContent), brief=clean(card.querySelector('.desc')?.textContent);
     const dateText=clean(card.querySelector('.time')?.textContent);
     if (!matched(title+' '+brief) || !deadline(dateText)) continue;
     card.click();await pause(650);
     const detail=document.querySelector('.detail .info');
     const frame=document.querySelector('.detail iframe[src]');
     const rawUrl=frame?.src?.startsWith('https://fe.xiaohongshu.com/ditto/vincent/')?frame.src:location.href;
     const official=new URL(rawUrl);official.search='';official.hash='';const url=official.href;
     const body=clean(detail?.innerText||'');
     add(make(title,url,`${brief}\n${body}\n注意：活动侧栏可能只包含简介，详细参与资格与奖励仍须在官方活动页核对。`,dateText,body.length>=200&&/活动规则|参与方式|投稿要求/.test(body)?'detail':'summary'));
     document.querySelector('.detail .close,.detail [aria-label="关闭"]')?.click();
    }
    const next=[...document.querySelectorAll('.pagination .d-pagination-page')].find(x=>clean(x.textContent)===String(page+1));
    if (!next) break;
    const before=clean(cards[0]?.querySelector('.title')?.textContent);next.click();
    for(let i=0;i<12;i++){await pause(250);if(clean(document.querySelector('.card-box .title')?.textContent)!==before)break;}
   }
  } else if (platform === '抖音') {
   await progress('抖音活动日历');
   const calendar=document.querySelector('.douyin-creator-common-calendar')||document.body;
   const year=Number(clean(calendar.innerText).match(/(20\d{2})年/)?.[1])||new Date().getFullYear();
   const cards=[...document.querySelectorAll('.douyin-creator-common-calendar-event-item')];
   if(!cards.length) warnings.push('抖音活动日历没有可读取条目');
   const titles=new Set();
   for(const card of cards){
    if(items.length>=maxItems)break;
    const title=clean(card.textContent);if(!title||titles.has(title))continue;titles.add(title);
    card.click();await pause(450);
    const dialog=document.querySelector('[role="dialog"]');
    const body=clean(dialog?.innerText||'');
    const dateText=body.match(/(?:20\d{2}[年/.\-])?\d{1,2}[月/.\-]\d{1,2}[^。\n]{0,40}(?:20\d{2}[年/.\-])?\d{1,2}[月/.\-]\d{1,2}/)?.[0]||body;
    if(matched(title+' '+body)) add(make(title,location.href,body,dateText,body.length>=50?'detail':'summary',year));
    dialog?.querySelector('[aria-label="关闭"],.close,[class*="close"]')?.click();
    await pause(100);
   }
   warnings.push('抖音仅扫描当前显示月份；跨月活动请在官方日历切换月份后再采集');
  } else if (platform === '快手') {
   await progress('快手活动中心');
   for(let scroll=0;scroll<maxPages && items.length<maxItems;scroll++) {
    const cards=[...document.querySelectorAll('.list_item')];
    for(const card of cards){
     if(items.length>=maxItems)break;
     const title=clean(card.querySelector('.list_item_main_title')?.textContent);
     const brief=clean(card.querySelector('.list_item_main_breif')?.textContent);
     const dateText=clean(card.querySelector('.list_item_main_time')?.textContent);
     if(!title||!matched(title+' '+brief)||!deadline(dateText))continue;
     const link=card.querySelector('a[href]');let url=link?.href||location.href,body=brief;
     // Never click the enrollment button (“去领取”). Only the title/link may reveal rules.
     const opener=card.querySelector('.list_item_main_title');
     if(opener){try{const watch=await chrome.runtime.sendMessage({type:'draftdesk:watch-tab'});opener.click();await pause(550);const result=await chrome.runtime.sendMessage({type:'draftdesk:finish-watch',id:watch.id});if(result.ok){url=result.result.url;body=result.result.text;}else warnings.push(`${title}：${result.error}`);}catch(e){warnings.push(`${title}：详情未打开 ${e.message}`);}}
     add(make(title,url,`${brief}\n${body}`,dateText,body.length>=50?'detail':'summary'));
    }
    window.scrollBy(0,Math.max(700,innerHeight));await pause(550);
   }
  }
  return {schemaVersion:'draftdesk.activity-batch.v1',keywords,platform,items,warnings:warnings.slice(0,50)};
 }
 chrome.runtime.onMessage.addListener((message,_sender,respond)=>{
  if(message?.type!=='draftdesk:auto')return;
  const config={...message.config,startedAt:new Date().toISOString()};
  chrome.storage.local.set({draftdeskActivityRun:{state:'running',progress:'正在读取官方活动页',startedAt:config.startedAt}}).then(()=>run(config)).then(bundle=>chrome.storage.local.set({draftdeskActivityRun:{state:'completed',bundle,progress:`完成：${bundle.items.length} 条未过期候选`,startedAt:config.startedAt}})).catch(e=>chrome.storage.local.set({draftdeskActivityRun:{state:'failed',progress:e.message,startedAt:config.startedAt}}));
  respond({ok:true});
 });
}
