import { Store, now } from "../core/store";
import { qualityIssues } from "../core/quality";
import type { Artifact, Evidence } from "../core/schema";

// Deterministic downgrade only: never promotes or edits generated content.
const db = new Store();
try {
  let changed = 0;
  db.transaction(() => {
    for (const item of db.list<Artifact>("artifacts")) {
      const evidence = item.evidenceIds.map((id) => db.get<Evidence>("evidence", id)).filter((e): e is Evidence => !!e);
      const issues = [...new Set([...item.issues, ...qualityIssues(item, evidence)])];
      if (issues.length && (issues.length !== item.issues.length || item.quality !== "review")) {
        db.put("artifacts", item.id, { ...item, issues, quality: "review", visibility: "private", revision: item.revision + 1, updatedAt: now() });
        changed++;
      }
    }
  });
  console.log(JSON.stringify({ rechecked: db.list("artifacts").length, updated: changed }));
} finally { db.close(); }
