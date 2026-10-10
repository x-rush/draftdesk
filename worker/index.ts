import { Store, now } from "../core/store";
import { runJob, scheduleTick } from "../core/pipeline";
import { seenTermsTick } from "../core/seen-extract";
import { requestModel } from "../core/model";
import { runJanitor } from "../core/janitor";
const db = new Store();
let stopping = false;
process.on("SIGTERM", () => {
  stopping = true;
});
process.on("SIGINT", () => {
  stopping = true;
});
console.log("DraftDesk research worker started");
while (!stopping) {
  db.put("meta", "worker", { heartbeat: now(), pid: process.pid });
  scheduleTick(db);
  seenTermsTick(db, requestModel);
  runJanitor(db);
  const job = db.claim();
  if (job) await runJob(db, job);
  else await new Promise((r) => setTimeout(r, 1500));
}
db.close();
