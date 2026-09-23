import { Store } from "../core/store";
import { recordHistory } from "../core/history";
import type { Evidence } from "../core/schema";
// Idempotent: derive indexes from saved evidence, never invent missing observations.
const db = new Store();
try {
  db.transaction(()=>{
    for (const evidence of db.list<Evidence>("evidence").sort((a,b)=>a.collectedAt.localeCompare(b.collectedAt))) recordHistory(db,evidence);
  });
  console.log(JSON.stringify({events:db.list("events").length,metrics:db.list("metrics").length}));
} finally {db.close();}
