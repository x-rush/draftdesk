import test from "node:test";
import assert from "node:assert/strict";
import {activityPageSchema,officialActivityUrl} from "../core/activity-import";
test("活动导入限制官方域名，不接受伪造子域、凭据和脚本地址",()=>{assert.equal(officialActivityUrl("https://creator.douyin.com/a"),true);for(const u of ["https://douyin.com.evil.test/a","https://evil-douyin.com/a","javascript:alert(1)","https://user:pass@douyin.com/a","http://douyin.com/a"])assert.equal(officialActivityUrl(u),false);});
test("活动文件校验版本、长度及来源，丢弃额外字段",()=>{const x={schemaVersion:"draftdesk.activity-page.v1",title:"活动规则",url:"https://www.bilibili.com/blackboard/a",text:"活动说明".repeat(30),cookie:"should-not-pass"};assert.equal("cookie" in activityPageSchema.parse(x),false);assert.equal(activityPageSchema.safeParse({...x,text:"短"}).success,false);assert.equal(activityPageSchema.safeParse({...x,schemaVersion:"other"}).success,false);});
