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
  truncateSnippet,
  buildSections,
  createSearxngSection,
  createRagSection,
  resolveSourcesParameter,
  formatSearxngOutput,
  formatEnhancedSearchOutput,
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
