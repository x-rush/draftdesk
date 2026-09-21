import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { Store, now } from "../core/store";
const root = process.argv[2];
if (!root)
  throw Error(
    "Usage: npm exec tsx scripts/migrate-legacy.ts <old-project-root>",
  );
const db = new Store();
const read = (name: string) => {
  const file = path.join(root, "data", "research", name);
  return existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : undefined;
};
if (!db.get("meta", "legacy-config-imported")) {
  const old = read("settings.json");
  if (old) {
    const current = db.config();
    db.put("config", "main", {
      ...current,
      baseUrl: old.baseUrl || current.baseUrl,
      model: old.model || current.model,
      profile: old.profile || current.profile,
      apiKey: old.apiKey,
      tavilyKey: old.tavilyKey,
    });
  }
  for (const file of [
    "workspace.json",
    "ideas.json",
    "trends.json",
    "reviews.json",
  ]) {
    const content = read(file);
    if (content) db.put("legacy-research", file, content);
  }
  db.put("meta", "legacy-config-imported", { at: now() });
}
console.log(
  "Legacy configuration migrated; sensitive values were not printed. Browser topics migrate at first visit.",
);
db.close();
