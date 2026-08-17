import { test } from "node:test";
import assert from "node:assert/strict";

// Pure helpers exported from the plugin (built lib), exercised without a
// full harness boot. The topic→category mapping, source mapping/capping, and
// two-section render are all pure.
import {
  TOPIC_CATEGORIES,
  topicToCategory,
  mapSearxngSource,
  mapSearxngResults,
  truncateSnippet,
  formatSearxngOutput,
  formatEnhancedSearchOutput,
} from "../lib/index.js";

test("topic→category mapping covers all allowed values verbatim", () => {
  const expected = {
    general: "general",
    news: "news",
    science: "science",
    it: "it",
    files: "files",
    "social media": "social media",
    images: "images",
    videos: "videos",
    map: "map",
    music: "music",
  };
  assert.deepEqual(TOPIC_CATEGORIES, expected);
});

test("topicToCategory resolves known topics and ignores unknown/absent", () => {
  assert.equal(topicToCategory("general"), "general");
  assert.equal(topicToCategory("social media"), "social media");
  assert.equal(topicToCategory("music"), "music");
  assert.equal(topicToCategory("nonsense"), undefined);
  assert.equal(topicToCategory(undefined), undefined);
  assert.equal(topicToCategory("  news  "), "news"); // trimmed
});

test("mapSearxngSource maps title/content/publishedDate and skips missing url", () => {
  const mapped = mapSearxngSource({
    title: "Example",
    url: "https://example.com/a",
    content: "Some content",
    publishedDate: "2026-01-01T00:00:00Z",
    engine: "google",
    category: "general",
    score: 1,
  });
  assert.deepEqual(mapped, {
    url: "https://example.com/a",
    title: "Example",
    snippet: "Some content",
    publishedAt: "2026-01-01T00:00:00Z",
  });
  assert.equal(mapSearxngSource({ title: "No url" }), undefined);
  assert.equal(mapSearxngSource({ url: "   " }), undefined);
});

test("mapSearxngResults caps the SearXNG section to maxResults", () => {
  const items = [
    { url: "https://example.com/1", title: "one" },
    { url: "https://example.com/2", title: "two" },
    { url: "https://example.com/3", title: "three" },
    { url: "https://example.com/4", title: "four" },
  ];
  const capped = mapSearxngResults(items, 2);
  assert.equal(capped.length, 2);
  assert.equal(capped[0].url, "https://example.com/1");
  assert.equal(capped[1].url, "https://example.com/2");
  assert.deepEqual(mapSearxngResults(undefined, 8), []);
  assert.deepEqual(mapSearxngResults([{ title: "no url" }], 8), []);
});

test("truncateSnippet caps content to ~200 chars", () => {
  const long = "x".repeat(500);
  const got = truncateSnippet(long, 200);
  assert.ok(got !== undefined);
  assert.equal(got.length, 200);
  assert.ok(got.endsWith("…"));
  assert.equal(truncateSnippet("short", 200), "short");
  assert.equal(truncateSnippet(undefined, 200), undefined);
  assert.equal(truncateSnippet("   ", 200), undefined);
});

test("formatSearxngOutput emits the markdown block and omits when empty", () => {
  const sources = [
    { url: "https://example.com/1", title: "One", snippet: "snippet one" },
    { url: "https://example.com/2", snippet: "snippet two", publishedAt: "2026-01-01" },
  ];
  const text = formatSearxngOutput(sources);
  assert.ok(text.startsWith("## SearXNG results\n"));
  assert.ok(text.includes("- [One](https://example.com/1) — snippet one"));
  assert.ok(text.includes("- [example.com](https://example.com/2) — snippet two (2026-01-01)"));
  assert.equal(formatSearxngOutput([]), "");
});

test("formatEnhancedSearchOutput appends SearXNG only when present", () => {
  const value = {
    sources: [{ url: "https://native.example", title: "Native" }],
    truncated: false,
    searxngSources: [{ url: "https://sx.example", title: "SX" }],
  };
  const text = formatEnhancedSearchOutput(value);
  assert.ok(text.includes("## SearXNG results"));
  assert.ok(text.includes("[Native](https://native.example)"));

  const nativeOnly = { sources: value.sources, truncated: false };
  const textOnly = formatEnhancedSearchOutput(nativeOnly);
  assert.ok(!textOnly.includes("## SearXNG results"));
  assert.ok(textOnly.includes("[Native](https://native.example)"));
});
