import { Store } from "../core/store";
import { artifactSchema } from "../core/schema";
import { writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";

// No provider requests or mutations; machine-readable evidence for a local audit.
const db = new Store();
try {
  const cfg = db.config();
  const get = async (route: string) => {
    const response = await fetch(`${process.env.DRAFTDESK_ACCEPTANCE_URL || "http://host.docker.internal:5173"}/api/v1/${route}`);
    if (!response.ok) throw new Error(`${route}: HTTP ${response.status}`);
    return response;
  };
  const exported = await (await get("export")).text();
  const snapshot = await (await get("workspace")).json();
  const data = JSON.parse(exported);
  const skills = await (await get("skills")).json();
  const contract = await (await get("schema")).json();
  const bundle = new Uint8Array(await (await get("skill-bundle")).arrayBuffer());
  const publicData = await (await get("public")).json();
  const report = {
    at: new Date().toISOString(),
    checks: {
      health: (await (await get("health")).json()).ok,
      exportWithoutCredentials: [cfg.apiKey, cfg.tavilyKey].filter(Boolean).every((key) => !exported.includes(key!)),
      configMasked: !snapshot.config.apiKey && !snapshot.config.tavilyKey,
      artifactsValid: data.artifacts.every((a: any) => { const { id, kind, title, summary, audience, whyNow, personalImpact, tags, evidenceIds, claims, unknowns, nextActions, details } = a; return artifactSchema.safeParse({id,kind,title,summary,audience,whyNow,personalImpact,tags,evidenceIds,claims,unknowns,nextActions,details}).success; }),
      referencesExist: data.artifacts.every((a: any) => a.evidenceIds.every((id: string) => data.evidence.some((e: any) => e.id === id))),
      skillCount: skills.length,
      schemaHasEvidence: !!contract.properties?.evidence,
      tarSignature: new TextDecoder().decode(bundle.slice(257, 262)) === "ustar",
      publicProjectionExcludesPrivateFields: publicData.items.every((a: any) => !a.evidenceIds && !a.messages && ["news", "topic"].includes(a.kind)),
    },
    counts: { evidence: data.evidence.length, artifacts: data.artifacts.length, conversations: data.conversations.length },
    jobs: data.jobs.map((j: any) => ({id:j.id,plan:j.planId,state:j.state,calls:j.calls,actualTokens:j.actualTokens,reservedTokens:j.reservedTokens,error:j.error})),
  };
  const output = path.join(process.env.DRAFTDESK_DATA_DIR || "data", "acceptance");
  mkdirSync(output, { recursive: true });
  writeFileSync(path.join(output, "read-only-report.json"), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ checks: report.checks, counts: report.counts }, null, 2));
  if (Object.values(report.checks).some((v) => v === false)) process.exitCode = 1;
} finally { db.close(); }
