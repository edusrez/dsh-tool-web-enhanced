import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, appendFileSync, utimesSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  chunkMarkdown,
  parseSources,
  l2Normalize,
  RagEngine,
} from "../lib/rag.js";

// ---------------------------------------------------------------------------
// Deterministic fake embedder (hermetic: no network, no model download)
// ---------------------------------------------------------------------------

/**
 * Build an embedder that maps each text to a deterministic `dim`-vector via an
 * FNV-1a hash of its lowercase whitespace tokens. Shared tokens → shared
 * vector components, so lexically similar texts score similarly. The returned
 * vectors are already unit-normalized for stable distances.
 */
function makeFakeEmbedder(dim) {
  return async (texts) =>
    texts.map((text) => {
      const v = new Array(dim).fill(0);
      const tokens = text.toLowerCase().split(/\s+/).filter(Boolean);
      for (const token of tokens) {
        // FNV-1a 32-bit hash → bucket index.
        let h = 0x811c9dc5;
        for (let i = 0; i < token.length; i++) {
          h ^= token.charCodeAt(i);
          h = (h * 0x01000193) >>> 0;
        }
        const idx = h % dim;
        v[idx] += 1;
      }
      // Unit-normalize so FLOAT vectors are directly comparable.
      let sum = 0;
      for (const x of v) sum += x * x;
      const norm = Math.sqrt(sum);
      if (norm === 0) return v;
      return v.map((x) => x / norm);
    });
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const FRONTMATTER_DOC = `---
title: Example
tags: [a, b]
---

Intro paragraph before any heading.

## First Section
Some body under the first heading.

## Second Section
More body under the second heading.
`;

const LONG_SECTION = `## Long Heading
${Array.from({ length: 30 }, (_, i) => `paragraph ${i + 1} with a good amount of text to reach the windowing threshold.`).join("\n\n")}
`;

// ---------------------------------------------------------------------------
// chunkMarkdown
// ---------------------------------------------------------------------------

test("chunkMarkdown strips frontmatter and splits on ## headings", () => {
  const chunks = chunkMarkdown(FRONTMATTER_DOC, "example.md");
  const titles = chunks.map((c) => c.title);
  assert.ok(!titles.includes("title: Example"));
  assert.ok(titles.includes("First Section"));
  assert.ok(titles.includes("Second Section"));

  const first = chunks.find((c) => c.title === "First Section");
  assert.ok(first.text.startsWith("Document: example.md\n\n## First Section\nSome body"));
  assert.ok(!first.text.includes("title: Example"), "frontmatter removed");
});

test("chunkMarkdown emits a single file-titled chunk when no ## headings", () => {
  const chunks = chunkMarkdown("Just some plain text without any level-2 headings here.", "plain.md");
  assert.equal(chunks.length, 1);
  assert.equal(chunks[0].title, "plain.md");
  assert.ok(!chunks[0].text.includes("Document: plain.md"), "context line skipped when title === file title");
});

test("chunkMarkdown windows long sections with (n/m) suffixes and overlap", () => {
  const chunks = chunkMarkdown(LONG_SECTION, "long.md");
  assert.ok(chunks.length > 1, "long section split into >1 window");
  const first = chunks[0];
  const second = chunks[1];
  assert.equal(first.title, "Long Heading (1/2)");
  assert.equal(second.title, "Long Heading (2/2)");
  // Overlap: the last ~200 chars of the first text reappear at the head of the second.
  const tail = first.text.slice(-50);
  assert.ok(second.text.includes(tail.slice(-20)), "windows overlap");
});

test("chunkMarkdown drops chunks shorter than 20 chars after trim", () => {
  const chunks = chunkMarkdown("## Tiny\nhi\n\n## Big Enough\nThis section is definitely long enough to be kept as a chunk.", "short.md");
  const titles = chunks.map((c) => c.title);
  assert.ok(!titles.includes("Tiny"), "tiny heading dropped");
  assert.ok(titles.includes("Big Enough"));
});

// ---------------------------------------------------------------------------
// parseSources
// ---------------------------------------------------------------------------

test("parseSources resolves all/singular/empty forms", () => {
  assert.equal(parseSources(undefined), "all");
  assert.equal(parseSources(""), "all");
  assert.equal(parseSources("ALL"), "all");
  assert.deepEqual(parseSources("native,rag"), new Set(["native", "rag"]));
  assert.equal(parseSources("foo"), "all");
  assert.deepEqual(parseSources("native, searxng , bogus"), new Set(["native", "searxng"]));
  assert.deepEqual(parseSources("RAG"), new Set(["rag"]));
});

// ---------------------------------------------------------------------------
// l2Normalize
// ---------------------------------------------------------------------------

test("l2Normalize unit-normalizes and leaves zero vectors unchanged", () => {
  const v = l2Normalize([3, 4, 0]);
  const norm = Math.sqrt(v[0] * v[0] + v[1] * v[1] + v[2] * v[2]);
  assert.ok(Math.abs(norm - 1) < 1e-9);
  assert.deepEqual(l2Normalize([0, 0, 0]), [0, 0, 0]);
});

// ---------------------------------------------------------------------------
// RagEngine (hermetic store: fake embedder + real in-tmp sqlite-vec)
// ---------------------------------------------------------------------------

async function makeFixtureDir() {
  const dir = mkdtempSync(join(tmpdir(), "rag-test-"));
  const docs = join(dir, "docs");
  mkdirSync(docs, { recursive: true });
  return { dir, docs };
}

test("RagEngine indexes idempotently and queries by similarity", async (t) => {
  const { dir, docs } = await makeFixtureDir();
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  writeFileSync(
    join(docs, "one.md"),
    "## Apples\nApples are a crisp and sweet fruit that grows on trees.\n\n## Bananas\nBananas are a soft and sweet fruit that grows in bunches.\n",
  );
  writeFileSync(join(docs, "two.md"), "Oranges are a citrus fruit full of vitamin C and very juicy.\n");

  const storePath = join(dir, "store.sqlite");
  const engine = new RagEngine({ storePath, embedder: makeFakeEmbedder(32) });
  const databases = [{ name: "docs", path: docs, topK: 3 }];

  const first = await engine.ensureIndex(databases);
  assert.ok(first.docs > 0, `first run indexes chunks: ${JSON.stringify(first)}`);
  const firstCount = first.docs;

  // Idempotent second run: unchanged mtimes → no new work, same total count.
  const second = await engine.ensureIndex(databases);
  assert.equal(second.docs, firstCount, "chunk counts stable across idempotent runs");

  const sections = await engine.query("apples are a crisp sweet fruit", databases);
  assert.equal(sections.length, 1, "one non-empty section");
  assert.equal(sections[0].name, "docs");
  assert.ok(sections[0].results.length > 0, "topK results returned");
  assert.equal(sections[0].results.length, 3, "respects topK");
  assert.equal(sections[0].results[0].title, "Apples", "closest section first");
  assert.equal(sections[0].results[0].path, join(docs, "one.md"), "closest section path");
  for (const r of sections[0].results) {
    assert.ok(r.score >= 0 && r.score <= 1, `score in [0,1]: ${r.score}`);
    assert.ok(r.excerpt.length <= 242, "excerpt capped");
  }
});

test("RagEngine removes chunks for deleted files on re-index", async (t) => {
  const { dir, docs } = await makeFixtureDir();
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  writeFileSync(join(docs, "apple.md"), "## Apples\nApples are crisp and sweet and grow on trees.\n");
  writeFileSync(join(docs, "banana.md"), "## Bananas\nBananas are soft and sweet and grow in bunches.\n");

  const storePath = join(dir, "store.sqlite");
  const engine = new RagEngine({ storePath, embedder: makeFakeEmbedder(32) });
  const databases = [{ name: "docs", path: docs, topK: 2 }];

  await engine.ensureIndex(databases);
  const before = await engine.query("bananas are soft sweet fruit", databases);
  const bananaResult = before[0].results.some((r) =>
    r.path === join(docs, "banana.md") || r.title.includes("Bananas"),
  );
  assert.ok(bananaResult, "banana chunk present before deletion");

  rmSync(join(docs, "banana.md"));
  await engine.ensureIndex(databases);

  const after = await engine.query("bananas are soft sweet fruit", databases);
  const stillBanana = after.length > 0 && after[0].results.some((r) =>
    r.path === join(docs, "banana.md") || r.title.includes("Bananas"),
  );
  assert.ok(!stillBanana, "banana chunks removed after deletion");
});

test("RagEngine rebuilds when the embedding dimension changes", async (t) => {
  const { dir, docs } = await makeFixtureDir();
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  writeFileSync(join(docs, "apple.md"), "## Apples\nApples are crisp and sweet and grow on trees.\n");

  const storePath = join(dir, "store.sqlite");
  const databases = [{ name: "docs", path: docs, topK: 2 }];

  const engine32 = new RagEngine({ storePath, embedder: makeFakeEmbedder(32) });
  await engine32.ensureIndex(databases);

  // Different-dimension embedder over the same store → full rebuild.
  const engine16 = new RagEngine({ storePath, embedder: makeFakeEmbedder(16) });
  const rebuilt = await engine16.ensureIndex(databases);
  assert.ok(rebuilt.docs > 0, `rebuilds at new dim: ${JSON.stringify(rebuilt)}`);

  const sections = await engine16.query("apples are crisp sweet fruit", databases);
  assert.equal(sections.length, 1);
  assert.equal(sections[0].results[0].title, "Apples");
});

test("RagEngine does not re-embed unchanged files on re-index (dims check idempotence)", async (t) => {
  const { dir, docs } = await makeFixtureDir();
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  writeFileSync(
    join(docs, "one.md"),
    "## Apples\nApples are a crisp and sweet fruit that grows on trees.\n\n## Bananas\nBananas are a soft and sweet fruit that grows in bunches.\n",
  );

  // Count only chunk-batch embedding calls: `ensureIndex` always performs a
  // 1-text "probe" embed to learn the dimension, so a raw call counter would
  // tick even on an idempotent second run. A spurious re-embed of unchanged
  // files (the dims-check regression: `String(rowObject)` never equals
  // `String(dims)` → false `DROP TABLE` + rebuild) shows up as an extra
  // batch call.
  let batchEmbedCalls = 0;
  const baseEmbedder = makeFakeEmbedder(32);
  const countingEmbedder = async (texts) => {
    if (!(texts.length === 1 && texts[0] === "probe")) batchEmbedCalls += 1;
    return baseEmbedder(texts);
  };

  const storePath = join(dir, "store.sqlite");
  const engine = new RagEngine({ storePath, embedder: countingEmbedder });
  const databases = [{ name: "docs", path: docs, topK: 2 }];

  await engine.ensureIndex(databases);
  assert.ok(batchEmbedCalls > 0, "first run embeds file chunks");

  const afterFirst = batchEmbedCalls;
  await engine.ensureIndex(databases);
  assert.equal(
    batchEmbedCalls,
    afterFirst,
    "unchanged files are not re-embedded on the second run (mtime idempotence)",
  );
});

test("RagEngine.query awaits ensureIndex when the store is empty", async (t) => {
  const { dir, docs } = await makeFixtureDir();
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  writeFileSync(
    join(docs, "algo.md"),
    "## Algorithms\nAlgorithms sort data and search for matching items in a collection.\n",
  );

  const storePath = join(dir, "store.sqlite");
  assert.equal(existsSync(storePath), false, "store file does not exist yet");

  // Count only chunk-batch embedding calls (probe embeds are excluded via the
  // existing pattern) to prove query() ran the index itself: without it, no
  // chunk is ever embedded and the db section would come back empty.
  let batchEmbedCalls = 0;
  const baseEmbedder = makeFakeEmbedder(32);
  const countingEmbedder = async (texts) => {
    if (!(texts.length === 1 && texts[0] === "probe")) batchEmbedCalls += 1;
    return baseEmbedder(texts);
  };

  const engine = new RagEngine({ storePath, embedder: countingEmbedder });
  const databases = [{ name: "docs", path: docs, topK: 2 }];

  // No prior ensureIndex(): query() must build the index itself.
  const sections = await engine.query("algo", databases);

  assert.equal(sections.length, 1, "a non-empty section comes back for the db");
  assert.ok(sections[0].results.length > 0, "results returned for the indexed db");
  assert.ok(batchEmbedCalls > 0, "query() embedded chunks (ran ensureIndex itself)");
});

test("RagEngine re-indexes a changed file without rowid collision", async (t) => {
  const { dir, docs } = await makeFixtureDir();
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  const filePath = join(docs, "one.md");
  writeFileSync(
    filePath,
    "## Apples\nApples are a crisp and sweet fruit that grows on trees.\n",
  );

  const storePath = join(dir, "store.sqlite");
  const engine = new RagEngine({ storePath, embedder: makeFakeEmbedder(32) });
  const databases = [{ name: "docs", path: docs, topK: 2 }];

  await engine.ensureIndex(databases);

  // Change the file and force a distinct mtime so the store detects the change.
  appendFileSync(
    filePath,
    "\n## Bananas\nBananas are a soft and sweet fruit that grows in bunches.\n",
  );
  utimesSync(filePath, new Date(), new Date(Date.now() + 5000));

  // Re-index must NOT throw a UNIQUE primary-key violation on the persisted
  // chunks table: rowids continue from the stored max and are never reused.
  await engine.ensureIndex(databases);

  const sections = await engine.query("apples bananas sweet fruit", databases);
  assert.equal(sections.length, 1, "one non-empty section after re-index");
  assert.ok(sections[0].results.length > 0, "results returned after re-index");
  assert.ok(
    sections[0].results.some((r) => r.title.includes("Bananas")),
    "the newly added section is queryable after re-index",
  );
});

test("RagEngine unchanged file re-index does not collide", async (t) => {
  const { dir, docs } = await makeFixtureDir();
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  writeFileSync(
    join(docs, "one.md"),
    "## Apples\nApples are a crisp and sweet fruit that grows on trees.\n",
  );

  const storePath = join(dir, "store.sqlite");
  const engine = new RagEngine({ storePath, embedder: makeFakeEmbedder(32) });
  const databases = [{ name: "docs", path: docs, topK: 2 }];

  const first = await engine.ensureIndex(databases);
  assert.ok(first.docs > 0, `indexed chunks: ${JSON.stringify(first)}`);
  const firstCount = first.docs;

  // Identical, unchanged file on the second run: no inserts happen, so no
  // rowid reuse, no UNIQUE error, and the chunk count stays stable.
  const second = await engine.ensureIndex(databases);
  assert.equal(second.docs, firstCount, "chunk counts stable across unchanged re-index");
});
