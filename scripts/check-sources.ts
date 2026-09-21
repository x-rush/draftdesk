import { safeRead, parseFeed } from "../core/sources";
import { defaultSources } from "../core/defaults";
for (const source of defaultSources.filter(
  (s) => s.type === "rss" || s.type === "trends",
)) {
  try {
    const address =
      source.url ||
      `https://trends.google.com/trending/rss?geo=${source.region}`;
    const results = parseFeed(await safeRead(address), source);
    console.log(
      JSON.stringify({
        source: source.name,
        items: results.length,
        ok: results.length > 0,
      }),
    );
  } catch (e) {
    console.log(
      JSON.stringify({
        source: source.name,
        ok: false,
        error: e instanceof Error ? e.message : "failed",
      }),
    );
  }
}
try {
  const result = JSON.parse(
    await safeRead(
      "https://api.github.com/search/repositories?q=topic%3Aai%20stars%3A%3E50&sort=updated&per_page=3",
    ),
  );
  console.log(
    JSON.stringify({
      source: "GitHub",
      items: result.items?.length || 0,
      ok: !!result.items?.length,
    }),
  );
} catch (e) {
  console.log(
    JSON.stringify({
      source: "GitHub",
      ok: false,
      error: e instanceof Error ? e.message : "failed",
    }),
  );
}
