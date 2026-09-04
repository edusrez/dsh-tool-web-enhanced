import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { RagEngine } from "../lib/rag.js";
import {
  TOPIC_CATEGORIES,
  topicToCategory,
  mapSearxngSource,
  mapSearxngResults,
  mapParallelSource,
  mapParallelResults,
  pickParallelSnippet,
  deriveParallelSearchQueries,
  truncateSnippet,
  buildSections,
  createSearxngSection,
  createParallelSection,
  createRagSection,
  resolveSourcesParameter,
  formatSearxngOutput,
  formatEnhancedSearchOutput,
  PARALLEL_API_URL,
  PARALLEL_MODE_DEFAULT,
  PARALLEL_SNIPPET_MAX_CHARS,
} from "../lib/index.js";

// ---------------------------------------------------------------------------
// topic → category mapping
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// SearXNG source mapping
// ---------------------------------------------------------------------------

test("mapSearxngSource maps title/content and skips missing url", () => {
  const mapped = mapSearxngSource({
    title: "Example",
    url: "https://example.com/a",
    content: "Some content",
    engine: "google",
    category: "general",
    score: 1,
  });
  assert.deepEqual(mapped, {
    url: "https://example.com/a",
    title: "Example",
    snippet: "Some content",
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
    { url: "https://example.com/2", snippet: "snippet two" },
  ];
  const text = formatSearxngOutput(sources);
  assert.ok(text.startsWith("## SearXNG results\n"));
  assert.ok(text.includes("- **One** — https://example.com/1 — snippet one"));
  assert.ok(text.includes("- **example.com** — https://example.com/2 — snippet two"));
  assert.equal(formatSearxngOutput([]), "");
});

// ---------------------------------------------------------------------------
// buildSections: ordering + enable
// ---------------------------------------------------------------------------

test("buildSections returns enabled sections in config order", () => {
  const sections = buildSections(
    {
      searxng: { enabled: true, url: "http://127.0.0.1:8080" },
      rag: { enabled: true, databases: [] },
    },
    {},
  );
  assert.deepEqual(sections.map((s) => s.id), ["searxng", "rag"]);
  assert.ok(sections.every((s) => s.enabled));
});

test("buildSections skips disabled sections and keeps config order", () => {
  const sections = buildSections(
    {
      searxng: { enabled: false, url: "http://127.0.0.1:8080" },
      rag: { enabled: true, databases: [] },
    },
    {},
  );
  assert.deepEqual(sections.map((s) => s.id), ["rag"]);
});

test("buildSections warns on and ignores unknown ids", (t) => {
  const warnings = [];
  const originalWarn = console.warn;
  t.after(() => {
    console.warn = originalWarn;
  });
  console.warn = (msg) => warnings.push(String(msg));

  const sections = buildSections(
    {
      searxng: { enabled: true, url: "http://127.0.0.1:8080" },
      bogus: { enabled: true },
    },
    {},
  );
  assert.deepEqual(sections.map((s) => s.id), ["searxng"]);
  assert.ok(warnings.some((w) => w.includes("bogus")), "warned about unknown id");
});

// ---------------------------------------------------------------------------
// Sources resolution with modules
// ---------------------------------------------------------------------------

function builtSections() {
  return buildSections(
    {
      searxng: { enabled: true, url: "http://127.0.0.1:8080" },
      rag: { enabled: true, databases: [] },
    },
    {},
  );
}

test("sources resolution: all/empty select native + every enabled section", () => {
  const sections = builtSections();
  for (const input of [undefined, "", "all", "ALL"]) {
    const resolved = resolveSourcesParameter(input, sections);
    assert.equal(resolved.native, true, `native for '${input}'`);
    assert.deepEqual([...resolved.sections].sort(), ["rag", "searxng"]);
  }
});

test("sources resolution: explicit tokens and unknown-ignored", () => {
  const sections = builtSections();
  assert.deepEqual(
    resolveSourcesParameter("native,searxng", sections),
    { native: true, sections: new Set(["searxng"]) },
  );
  assert.deepEqual(
    resolveSourcesParameter("rag", sections),
    { native: false, sections: new Set(["rag"]) },
  );
  // Unknown-only resolves to all.
  assert.deepEqual(
    resolveSourcesParameter("bogus", sections),
    { native: true, sections: new Set(["rag", "searxng"]) },
  );
  // native with only-unknown section tokens: native runs, no sections.
  assert.deepEqual(
    resolveSourcesParameter("bogus,native", sections),
    { native: true, sections: new Set() },
  );
  // Mixed unknown + known: unknowns ignored.
  assert.deepEqual(
    resolveSourcesParameter("bogus,searxng", sections),
    { native: false, sections: new Set(["searxng"]) },
  );
});

test("sources resolution honours the enabled sections (rag disabled)", () => {
  const sections = buildSections(
    { searxng: { enabled: true, url: "http://127.0.0.1:8080" }, rag: { enabled: false, databases: [] } },
    {},
  );
  const resolved = resolveSourcesParameter("rag", sections);
  // `rag` is not an enabled section id → not selected; unknown-only → all.
  assert.equal(resolved.native, true);
  assert.deepEqual([...resolved.sections].sort(), ["searxng"]);
});

// ---------------------------------------------------------------------------
// SearXNG section run (stub fetch)
// ---------------------------------------------------------------------------

function makeSearxngResponse(results) {
  return {
    ok: true,
    status: 200,
    async json() {
      return { results };
    },
  };
}

test("createSearxngSection.run returns one 'SearXNG results' block", async (t) => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    assert.ok(String(url).includes("q="), "query param present");
    return makeSearxngResponse([
      { url: "https://example.com/1", title: "One", content: "snippet one" },
      { url: "https://example.com/2", title: "Two", content: "snippet two" },
    ]);
  };
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  const section = createSearxngSection({ enabled: true, url: "http://127.0.0.1:8080" });
  const blocks = await section.run("query", {
    maxResults: 8,
    sources: new Set(["searxng"]),
    topic: "news",
  });
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0].name, "SearXNG results");
  assert.equal(blocks[0].sources.length, 2);
  assert.equal(blocks[0].sources[0].url, "https://example.com/1");
  assert.equal(blocks[0].sources[0].title, "One");
  assert.equal(blocks[0].sources[0].snippet, "snippet one");
});

test("createSearxngSection.run degrades (undefined) when results are empty", async (t) => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => makeSearxngResponse([]);
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  const section = createSearxngSection({ enabled: true, url: "http://127.0.0.1:8080" });
  const blocks = await section.run("query", {
    maxResults: 8,
    sources: new Set(["searxng"]),
  });
  assert.equal(blocks, undefined);
});

test("createSearxngSection.run omits when disabled or url empty", async () => {
  const section = createSearxngSection({ enabled: false, url: "http://127.0.0.1:8080" });
  assert.equal(
    await section.run("q", { maxResults: 8, sources: new Set() }),
    undefined,
  );
  const sectionNoUrl = createSearxngSection({ enabled: true, url: "" });
  assert.equal(
    await sectionNoUrl.run("q", { maxResults: 8, sources: new Set() }),
    undefined,
  );
});

// ---------------------------------------------------------------------------
// RAG section run (fake embedder)
// ---------------------------------------------------------------------------

/**
 * Deterministic fake embedder (hermetic: no network, no model download):
 * maps each text to a fixed `dim`-vector via an FNV-1a hash of its tokens.
 */
function makeFakeEmbedder(dim) {
  return async (texts) =>
    texts.map((text) => {
      const v = new Array(dim).fill(0);
      const tokens = text.toLowerCase().split(/\s+/).filter(Boolean);
      for (const token of tokens) {
        let h = 0x811c9dc5;
        for (let i = 0; i < token.length; i++) {
          h ^= token.charCodeAt(i);
          h = (h * 0x01000193) >>> 0;
        }
        v[h % dim] += 1;
      }
      let sum = 0;
      for (const x of v) sum += x * x;
      const norm = Math.sqrt(sum);
      if (norm === 0) return v;
      return v.map((x) => x / norm);
    });
}

test("createRagSection.run maps to RAG — <db> blocks", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "rag-module-test-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  const docs = join(dir, "docs");
  mkdirSync(docs, { recursive: true });
  writeFileSync(
    join(docs, "one.md"),
    "## Apples\nApples are a crisp and sweet fruit that grows on trees.\n",
  );

  const engine = new RagEngine({
    storePath: join(dir, "store.sqlite"),
    embedder: makeFakeEmbedder(32),
  });
  const section = createRagSection({
    enabled: true,
    engine,
    databases: [{ name: "docs", path: docs, topK: 3 }],
  });

  const blocks = await section.run("apples are a crisp sweet fruit", {
    maxResults: 8,
    sources: new Set(["rag"]),
  });
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0].name, "RAG — docs");
  assert.ok(blocks[0].sources.length > 0);
  const src = blocks[0].sources[0];
  assert.equal(src.path, join(docs, "one.md"));
  assert.equal(src.url, join(docs, "one.md"));
  assert.equal(typeof src.title, "string");
  assert.equal(typeof src.snippet, "string");
  assert.ok(src.score >= 0 && src.score <= 1, "score in [0,1]");
});

test("createRagSection.run degrades (undefined) without an engine or databases", async () => {
  const section = createRagSection({ enabled: true, engine: undefined, databases: [] });
  assert.equal(
    await section.run("q", { maxResults: 8, sources: new Set(["rag"]) }),
    undefined,
  );
});

test("createRagSection.ensureIndex forwards to the engine", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "rag-index-test-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  const docs = join(dir, "docs");
  mkdirSync(docs, { recursive: true });
  writeFileSync(
    join(docs, "one.md"),
    "## Apples\nApples are a crisp and sweet fruit that grows on trees.\n",
  );

  const engine = new RagEngine({
    storePath: join(dir, "store.sqlite"),
    embedder: makeFakeEmbedder(32),
  });
  const section = createRagSection({
    enabled: true,
    engine,
    databases: [{ name: "docs", path: docs, topK: 2 }],
  });
  const counts = await section.ensureIndex([{ name: "docs", path: docs, topK: 2 }]);
  assert.ok(counts.docs > 0, `indexed chunks: ${JSON.stringify(counts)}`);
});

// ---------------------------------------------------------------------------
// formatEnhancedSearchOutput (new sections[] shape)
// ---------------------------------------------------------------------------

test("formatEnhancedSearchOutput renders native then each section block", () => {
  const value = {
    sources: [{ url: "https://native.example", title: "Native" }],
    truncated: false,
    sections: [
      {
        name: "SearXNG results",
        sources: [{ url: "https://sx.example", title: "SX", snippet: "snippet" }],
      },
      {
        name: "RAG — docs",
        sources: [{
          url: "/path/one.md",
          title: "Apples",
          snippet: "excerpt here",
          score: 0.5,
          path: "/path/one.md",
        }],
      },
    ],
  };
  const text = formatEnhancedSearchOutput(value);
  assert.ok(text.includes("[Native](https://native.example)"));
  assert.ok(text.includes("## SearXNG results"));
  assert.ok(text.includes("- **SX** — https://sx.example"));
  assert.ok(text.includes("## RAG — docs"));
  assert.ok(text.includes("- **Apples** — /path/one.md (score 0.500)"));
  assert.ok(text.includes("  excerpt here"));
});

test("formatEnhancedSearchOutput omits sections when absent/empty", () => {
  const nativeOnly = { sources: [{ url: "https://native.example", title: "Native" }], truncated: false };
  const text = formatEnhancedSearchOutput(nativeOnly);
  assert.ok(!text.includes("## SearXNG results"));
  assert.ok(text.includes("[Native](https://native.example)"));
});

test("execute-level degrade: one section that throws is omitted, healthy sections still render", async (t) => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => makeSearxngResponse([
    { url: "https://example.com/1", title: "One", content: "snippet one" },
  ]);
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  const sections = buildSections(
    {
      searxng: { enabled: true, url: "http://127.0.0.1:8080" },
      rag: { enabled: true, databases: [] },
    },
    {},
  );

  // Force the RAG section's run to reject, simulating a real per-section
  // failure. (A genuine searxng fetch rejection degrades to undefined rather
  // than throwing, so we exercise the throw path via the orchestration loop.)
  const ragSection = sections.find((s) => s.id === "rag");
  ragSection.run = async () => {
    throw new Error("simulated rag failure");
  };

  // Capture the logged failure without spamming test output.
  const errors = [];
  const originalError = console.error;
  t.after(() => {
    console.error = originalError;
  });
  console.error = (msg) => errors.push(String(msg));

  // Replicate the execute-level section orchestration loop verbatim from
  // src/index.ts `execute`: a rejecting section is omitted, others still run.
  const blocks = [];
  const maxResults = 8;
  const wanted = resolveSourcesParameter(undefined, sections); // all → every enabled section
  for (const section of sections) {
    if (!section.enabled) continue;
    if (!wanted.sections.has(section.id)) continue;
    try {
      const produced = await section.run("query", {
        maxResults,
        topic: "general",
        sources: wanted.sections,
      });
      if (produced !== undefined) blocks.push(...produced);
    } catch (err) {
      console.error(`[dsh-tool-web-enhanced] section '${section.id}' failed:`, err);
    }
  }

  // The throwing rag section is omitted; the healthy searxng block remains.
  assert.equal(blocks.length, 1, "only the healthy section produced blocks");
  assert.equal(blocks[0].name, "SearXNG results");
  assert.ok(errors.some((e) => e.includes("rag")), "rag failure was logged");

  // The rendered output keeps the healthy section and omits the throwing one.
  const text = formatEnhancedSearchOutput({ sources: [], truncated: false, sections: blocks });
  assert.ok(text.includes("## SearXNG results"));
  assert.ok(!text.includes("## RAG"), "throwing section absent from render");
});

// ---------------------------------------------------------------------------
// Parallel section (attempt to run / map)
// ---------------------------------------------------------------------------

test("deriveParallelSearchQueries returns the query as a single-element array", () => {
  assert.deepEqual(deriveParallelSearchQueries("latest ai news"), ["latest ai news"]);
});

test("pickParallelSnippet picks the densest excerpt and truncates it", () => {
  const first = "short";
  const dense = "x".repeat(900);
  assert.equal(pickParallelSnippet([first, dense]), "x".repeat(PARALLEL_SNIPPET_MAX_CHARS - 1) + "…");
  assert.equal(pickParallelSnippet([first]), first);
  assert.equal(pickParallelSnippet([]), undefined);
  assert.equal(pickParallelSnippet(undefined), undefined);
});

test("mapParallelSource maps url/title/snippet and skips missing url", () => {
  const mapped = mapParallelSource({
    url: "https://parallel.example/a",
    title: "Example",
    excerpts: ["a dense excerpt here"],
    publish_date: "2026-04-24",
  });
  assert.deepEqual(mapped, {
    url: "https://parallel.example/a",
    title: "Example",
    snippet: "a dense excerpt here",
  });
  assert.equal(mapParallelSource({ title: "No url" }), undefined);
  assert.equal(mapParallelSource({ url: "   " }), undefined);
  // A result with no usable excerpt has no snippet.
  assert.deepEqual(mapParallelSource({ url: "https://parallel.example/b" }), { url: "https://parallel.example/b" });
});

test("mapParallelResults caps the Parallel section to maxResults", () => {
  const items = [
    { url: "https://parallel.example/1", title: "one" },
    { url: "https://parallel.example/2", title: "two" },
    { url: "https://parallel.example/3", title: "three" },
    { url: "https://parallel.example/4", title: "four" },
  ];
  const capped = mapParallelResults(items, 2);
  assert.equal(capped.length, 2);
  assert.equal(capped[0].url, "https://parallel.example/1");
  assert.equal(capped[1].url, "https://parallel.example/2");
  assert.deepEqual(mapParallelResults(undefined, 8), []);
  assert.deepEqual(mapParallelResults([{ title: "no url" }], 8), []);
});

function makeFakeParallelResponse(results, ok = true, status = 200) {
  return {
    ok,
    status,
    async json() {
      return { results };
    },
  };
}

test("createParallelSection.run is inert (undefined, no fetch) without a key", async (t) => {
  const originalFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, opts) => {
    calls.push({ url, opts });
    return makeFakeParallelResponse([]);
  };
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  // Literal apiKey empty AND apiKeyEnv var absent → no resolvable key.
  const section = createParallelSection({
    enabled: true,
    apiKey: "",
    apiKeyEnv: "PARALLEL_API_KEY_TEST_UNSET",
  });
  const blocks = await section.run("query", {
    maxResults: 8,
    sources: new Set(["parallel"]),
  });
  assert.equal(blocks, undefined);
  assert.equal(calls.length, 0, "fetch must not be called without a key");
});

test("createParallelSection.run issues the correct Parallel request (POST, x-api-key, mode fast)", async (t) => {
  const originalFetch = globalThis.fetch;
  let captured;
  globalThis.fetch = async (url, opts) => {
    captured = { url, opts };
    return makeFakeParallelResponse([{ url: "https://parallel.example/1", title: "One", excerpts: ["snippet one"] }]);
  };
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  const section = createParallelSection({
    enabled: true,
    apiKey: "test-key-123",
    apiKeyEnv: "PARALLEL_API_KEY_TEST_UNSET",
  });
  const blocks = await section.run("latest ai news", {
    maxResults: 8,
    sources: new Set(["parallel"]),
  });
  assert.equal(captured.url, PARALLEL_API_URL);
  assert.equal(captured.opts.method, "POST");
  assert.equal(captured.opts.headers["x-api-key"], "test-key-123");
  assert.equal(captured.opts.headers["Content-Type"], "application/json");
  const body = JSON.parse(captured.opts.body);
  assert.equal(body.objective, "latest ai news");
  assert.deepEqual(body.search_queries, ["latest ai news"]);
  assert.equal(body.mode, "fast");
  assert.equal(PARALLEL_MODE_DEFAULT, "fast");
  assert.ok(blocks !== undefined);
});

test("createParallelSection.run maps the response to one 'Parallel results' block", async (t) => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () =>
    makeFakeParallelResponse([
      { url: "https://parallel.example/1", title: "One", excerpts: ["snippet one"] },
      { url: "https://parallel.example/2", title: "Two", excerpts: ["snippet two"] },
    ]);
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  const section = createParallelSection({ enabled: true, apiKey: "k", apiKeyEnv: "X" });
  const blocks = await section.run("query", {
    maxResults: 8,
    sources: new Set(["parallel"]),
  });
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0].name, "Parallel results");
  assert.equal(blocks[0].sources.length, 2);
  assert.equal(blocks[0].sources[0].url, "https://parallel.example/1");
  assert.equal(blocks[0].sources[0].title, "One");
  assert.equal(blocks[0].sources[0].snippet, "snippet one");
});

test("createParallelSection.run caps to min(ctx.maxResults, config.maxResults)", async (t) => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () =>
    makeFakeParallelResponse(
      Array.from({ length: 10 }, (_, i) => ({
        url: `https://parallel.example/${i}`,
        title: `T${i}`,
        excerpts: [`s${i}`],
      })),
    );
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  const section = createParallelSection({ enabled: true, apiKey: "k", apiKeyEnv: "X", maxResults: 3 });
  const blocks = await section.run("query", { maxResults: 8, sources: new Set(["parallel"]) });
  assert.equal(blocks[0].sources.length, 3);
});

test("createParallelSection.run degrades (undefined) on HTTP error or malformed body", async (t) => {
  const originalFetch = globalThis.fetch;
  const behaviors = [
    () => makeFakeParallelResponse([], false, 500), // non-2xx
    () => ({ ok: true, status: 200, json: async () => ({}) }), // missing results
    () => ({ ok: true, status: 200, json: async () => ({ results: "not-an-array" }) }), // malformed results
  ];
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  const section = createParallelSection({ enabled: true, apiKey: "k", apiKeyEnv: "X" });
  for (const behavior of behaviors) {
    globalThis.fetch = async () => behavior();
    const blocks = await section.run("query", { maxResults: 8, sources: new Set(["parallel"]) });
    assert.equal(blocks, undefined, `expected undefined for: ${behavior.toString()}`);
  }
});

test("createParallelSection.run degrades (undefined) when results are empty", async (t) => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => makeFakeParallelResponse([]);
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  const section = createParallelSection({ enabled: true, apiKey: "k", apiKeyEnv: "X" });
  const blocks = await section.run("query", { maxResults: 8, sources: new Set(["parallel"]) });
  assert.equal(blocks, undefined);
});

test("createParallelSection.run omits (undefined) when disabled", async () => {
  const section = createParallelSection({ enabled: false, apiKey: "k", apiKeyEnv: "X" });
  assert.equal(await section.run("q", { maxResults: 8, sources: new Set() }), undefined);
});

test("buildSections includes parallel and resolveSourcesParameter selects the parallel token", () => {
  const sections = buildSections(
    {
      searxng: { enabled: true, url: "http://127.0.0.1:8080" },
      parallel: { enabled: true, apiKey: "", apiKeyEnv: "PARALLEL_API_KEY_TEST_UNSET" },
      rag: { enabled: true, databases: [] },
    },
    {},
  );
  assert.deepEqual(sections.map((s) => s.id), ["searxng", "parallel", "rag"]);
  const resolved = resolveSourcesParameter("native,parallel", sections);
  assert.deepEqual(resolved, { native: true, sections: new Set(["parallel"]) });
});

// ---------------------------------------------------------------------------
// Presenter guard — the enhanced web_search records SINGULAR `query` args while
// the api-proxy replays sessions through the REGISTERED presenters. The STOCK
// presentSearchCall/presentSearchResult (plural `queries`) would throw
// `TypeError: Cannot read properties of undefined (reading 'join')` on any
// recorded enhanced call (the benign-but-noisy "api-proxy presenter" journald
// spam, QD D-Q3). The tool's presenters now normalize singular `query` to the
// plural array BEFORE delegating, so replay presents the SAME search card
// without throwing. 0 real APIs — pure presenter functions.
// ---------------------------------------------------------------------------

/**
 * A schema-equivalent RESOLVED enhanced config (the values the harness's
 * Cordis config resolution would produce from the defaults): every section
 * DISABLED so the enhanced web_search is registered without any seam/engine
 * activity (0 real APIs — pure registration + presenter functions).
 */
function resolvedMinimalConfig() {
  return {
    search: true,
    fetch: false,
    searchMaxResults: 8,
    fetchTimeoutMs: 30000,
    searchTimeoutMs: 60000,
    fetchMaxOutputChars: 200000,
    sections: {
      searxng: { enabled: false, url: "" },
      parallel: { enabled: false, apiKey: "", apiKeyEnv: "", mode: "fast", maxResults: 10 },
      rag: {
        enabled: false,
        storePath: "",
        embeddings: {
          provider: "auto",
          apiKeyEnv: "EMBEDDING_API_KEY",
          apiKey: "",
          model: "BAAI/bge-m3",
          baseURL: "https://api.deepinfra.com/v1/openai",
          localModel: "Xenova/bge-small-en-v1.5",
        },
        excludePaths: [],
        ignoreDotfiles: false,
        denyContent: [],
        databases: [],
      },
    },
    parallelExtract: { enabled: false, apiKey: "", apiKeyEnv: "PARALLEL_API_KEY", extractMode: "full", timeoutMs: 60000 },
  };
}

test("presenter guard: a recorded SINGULAR `query` call/result present without throwing and keeps the same search card title as the plural shape", async () => {
  // The api-proxy presents the tool registered in the scope: the ENHANCED
  // web_search (registered by this plugin) carries singular `query` in args.
  const { apply } = await import("../lib/index.js");
  const registered = [];
  const fakeCtx = {
    tools: {
      register(def) { registered.push(def); return () => {}; },
    },
    web: {},
    systemPrompt: { section: () => {} },
    logger: { info: () => {}, warn: () => {} },
  };
  apply(fakeCtx, resolvedMinimalConfig());
  const webSearch = registered.find((d) => d.name === "web_search");
  assert.ok(webSearch !== undefined, "the enhanced web_search is registered in the composition");

  // A call replayed from a session log carries the enhanced SINGULAR shape.
  const singularArgs = { query: "OpenAI GPT-6 Astra launch", topic: "news", sources: "native,rag" };
  const callView = webSearch.presentCall(singularArgs);
  assert.ok(callView !== undefined, "presentCall returns a view for the singular query args (NO TypeError)");
  assert.equal(callView.title, "OpenAI GPT-6 Astra launch", "the singular query drives the SAME card title the plural shape would");
  assert.equal(callView.kind, "search", "the search card kind is preserved");

  // The result path also normalizes (the stock presentSearchResult reads
  // args.queries for its title) — replay of a recorded enhanced result must
  // not throw either.
  const resultView = webSearch.presentResult(singularArgs, {
    content: [{ type: "text", text: "answer" }],
    isError: false,
    meta: {
      sources: [{ url: "https://example.com", title: "Example" }],
      truncated: false,
    },
  });
  assert.ok(resultView !== undefined, "presentResult returns a view for the singular query args (NO TypeError)");
  assert.equal(resultView.kind, "search", "the result card kind is preserved");
  assert.ok(Array.isArray(resultView.sources) && resultView.sources.length === 1, "the projected sources survive normalization");
});

test("presenter guard: the plural `queries` shape can NEVER throw — the schema-guard soft-falls to `undefined` (generic card), exactly the api-proxy behavior we need on replay", async () => {
  const { apply } = await import("../lib/index.js");
  const registered = [];
  const fakeCtx = {
    tools: { register(def) { registered.push(def); return () => {}; } },
    web: {},
    systemPrompt: { section: () => {} },
    logger: { info: () => {}, warn: () => {} },
  };
  apply(fakeCtx, resolvedMinimalConfig());
  const webSearch = registered.find((d) => d.name === "web_search");
  // The enhanced schema REQUIRES the singular `query` key — a plural-only args
  // object fails the schema guard, so presentCall soft-falls to undefined
  // (generic card). The CRITICAL property: it returns (or throws) WITHOUT a
  // `TypeError: ... reading 'join'` — the api-proxy presenter noise is gone.
  const callView = webSearch.presentCall({ queries: ["one", "two"] });
  assert.ok(callView === undefined || callView.title === "one, two", "a plural queries call soft-falls to generic or presents as the stock comma-joined title — NEVER throws")
});
