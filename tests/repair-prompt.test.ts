import test from "node:test";
import assert from "node:assert/strict";
import { z } from "zod";
import { buildRepairPrompt } from "../core/model";
import { researchBatchSchema } from "../core/schema";

const sampleSchema = JSON.stringify(
  z.toJSONSchema(
    z
      .object({
        items: z
          .array(
            z
              .object({
                kind: z.literal("news"),
                title: z.string().min(3).max(120),
                sourceType: z.enum(["official", "media", "community"]),
                publishedAt: z.string().datetime().nullable(),
              })
              .strict(),
          )
          .max(3),
        rejected: z.array(z.object({ reason: z.string().min(1) }).strict()).max(5),
      })
      .strict(),
  ),
);

test("结构模板：必填星标、枚举逐字值、字面量固定值、日期格式、数组项数", () => {
  const prompt = buildRepairPrompt(["items.0.title: Invalid input"], sampleSchema);
  assert.match(prompt, /## 输出结构模板/);
  assert.match(prompt, /- items\*: array（最多 3 项）/);
  assert.match(prompt, /- kind\*: 固定值，必须逐字写: "news"/);
  assert.match(prompt, /- sourceType\*: 枚举，只能逐字选一: "official" \| "media" \| "community"/);
  assert.match(prompt, /- publishedAt\*: 以下任一：/);
  assert.match(prompt, /string（ISO 8601 日期时间/);
  assert.match(prompt, /或 null：仅当确实无值可写时才用/);
  assert.match(prompt, /- rejected\*: array（最多 5 项）/);
});

test("最小有效输出骨架：只含必填字段，占位值符合字段形状，且可被 JSON.parse", () => {
  const prompt = buildRepairPrompt(["items.0: Invalid input"], sampleSchema);
  assert.match(prompt, /## 最小有效输出骨架/);
  assert.match(prompt, /"kind": "news"/);
  assert.match(prompt, /"title": "本轮未核实"/);
  assert.match(prompt, /"publishedAt": "2026-01-01T00:00:00Z"/);
  const skeleton = prompt.match(/## 最小有效输出骨架[^\n]*\n(\{[\s\S]*?\n\})\n/)?.[1];
  assert.ok(skeleton, "骨架段必须是独立的 JSON 块");
  const parsed = JSON.parse(skeleton) as any;
  assert.deepEqual(Object.keys(parsed), ["items", "rejected"]);
  assert.equal(parsed.items[0].sourceType, "official");
  assert.equal(parsed.rejected[0].reason, "本轮未核实");
});

test("额外键黑名单：从 issues 逐字提取 Unrecognized key 并禁止复现", () => {
  const prompt = buildRepairPrompt(
    ['items.1: Unrecognized key: "rejected"', "rejected: Invalid input: expected array, received undefined"],
    sampleSchema,
  );
  assert.match(prompt, /## 字段黑名单/);
  assert.match(prompt, /"rejected"/);
  assert.match(prompt, /绝不能塞进 items 元素等对象内部/);
  assert.match(prompt, /received undefined 的字段必须显式输出/);
});

test("枚举出口与条件块：undefined/clusters/claims/details 按问题文本路由", () => {
  const prompt = buildRepairPrompt(
    [
      "items.0.summary: Invalid input: expected string, received undefined",
      "clusters.0.label: Too small: expected string to have >=20 characters",
      "items.0.claims.0.type: Invalid input",
      "items.0.details: Invalid input: expected object, received undefined",
    ],
    sampleSchema,
  );
  assert.match(prompt, /枚举出口/);
  assert.match(prompt, /「本轮未核实」本身就是该字段的枚举值之一/);
  assert.match(prompt, /received undefined 的字段必须显式输出/);
  assert.match(prompt, /clusters 重写规则/);
  assert.match(prompt, /claims 重写规则/);
  assert.match(prompt, /缺失 details 时/);
});

test("条件块不误触发：无关问题不注入对应段落", () => {
  const prompt = buildRepairPrompt(["items.0.title: Too small: expected string to have >=3 characters"], sampleSchema);
  assert.doesNotMatch(prompt, /clusters 重写规则/);
  assert.doesNotMatch(prompt, /claims 重写规则/);
  assert.doesNotMatch(prompt, /缺失 details 时/);
  assert.match(prompt, /Too small 的字段必须显式输出|received undefined 的字段必须显式输出/);
});

test("真实研究合同 schema（editorial）可渲染完整模板与骨架", () => {
  const schemaJson = JSON.stringify(z.toJSONSchema(researchBatchSchema("editorial", 8)));
  const prompt = buildRepairPrompt(
    [
      'items.1: Unrecognized key: "rejected"',
      "rejected: Invalid input: expected array, received undefined",
      "items.0.claims.0.type: Invalid input",
    ],
    schemaJson,
  );
  assert.match(prompt, /- items\*: array（最多 8 项）/);
  assert.match(prompt, /- rejected\*: array（最多 30 项）/);
  assert.match(prompt, /"fact" \| "inference" \| "hypothesis"/);
  assert.match(prompt, /- evidenceIds\*: array（至少 1 项，最多 15 项）/);
  assert.match(prompt, /## 字段黑名单/);
  assert.match(prompt, /claims 重写规则/);
  const skeleton = prompt.match(/## 最小有效输出骨架[^\n]*\n(\{[\s\S]*?\n\})\n/)?.[1];
  assert.ok(skeleton, "真实合同的骨架必须可解析");
  const parsed = JSON.parse(skeleton) as any;
  assert.ok(Array.isArray(parsed.items) && Array.isArray(parsed.rejected));
  assert.equal(typeof parsed.items[0].evidenceIds, "object");
});
