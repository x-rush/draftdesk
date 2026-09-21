import { Store } from "../core/store";
import { evidence, topic, envelope } from "../tests/fixtures";
if (!process.env.DRAFTDESK_DATA_DIR?.includes("qa"))
  throw new Error("This script requires a separate QA data directory.");
const db = new Store();
evidence.forEach((e) => db.put("evidence", e.id, e));
const a = db.saveArtifact(
  { ...topic, title: "【隔离测试】" + topic.title },
  "qa-fixture",
  "ready",
  [],
  "模拟资料，只用于验证页面操作，不是真实新闻。",
);
db.intake({ ...envelope(), submissionId: "qa-intake" }, "qa");
console.log("QA fixtures created:", a.id);
db.close();
