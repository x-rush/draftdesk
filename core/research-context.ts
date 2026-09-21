import type { Evidence } from "./schema";

// Keep boundaries explicit: omitted text is never presented as a continuous quote.
export function evidenceContext(evidence: Evidence[], totalChars = 12000) {
  const limit = Math.max(300, Math.floor(totalChars / Math.max(1, evidence.length)));
  return evidence.map(({ provenance, fingerprint, ...e }) => {
    const truncated = e.excerpt.length > limit;
    const head = Math.floor(limit * 0.65);
    return {
      ...e,
      excerpt: truncated ? e.excerpt.slice(0, head) + "\n[中段省略，不能推断内容或拼接为连续引文]\n" + e.excerpt.slice(-(limit - head)) : e.excerpt,
      originalChars: e.excerpt.length,
      truncated,
    };
  });
}
