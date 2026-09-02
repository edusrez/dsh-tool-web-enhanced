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

// ---------------------------------------------------------------------------
// Ingestion filters (fb-15): denyContent, excludePaths, ignoreDotfiles
// ---------------------------------------------------------------------------

const SECRET_KEY = "sk-AbCdEfGhIjKlMnOpQrStUvWxYz0123456789";
const SECRET_ENV = "DEEPSEEK_API_KEY=sk-ZzYyXxWvUtSrQpOnMlKjIhGfEdCbA0987654321";
const SECRET_POOL = "OPENCODE_GO_KEY_1=sk-M9Bu7abcdefghijklmnopqrstuvwxyzABCDEF";
const AWS_KEY = "AKIAIOSFODNN7EXAMPLE"; // 20 chars (AKIA + 16), not sk-

test("chunkMarkdown drops secret-bearing chunks by default (built-in deny)", () => {
  // A chunk holding an sk- API key is discarded entirely.
  assert.deepEqual(
    chunkMarkdown(`## Pool\nSet ${SECRET_KEY} as the active key now.\n`, "pool.md"),
    [],
    "sk- key chunk dropped by the built-in denylist",
  );
  // A chunk holding a secret env assignment is discarded too.
  assert.deepEqual(
    chunkMarkdown(`## Deploy\nexport ${SECRET_ENV} for the agent run.\n`, "deploy.md"),
    [],
    "DEEPSEEK_API_KEY= chunk dropped by the built-in denylist",
  );
  assert.deepEqual(
    chunkMarkdown(`## Pool\nexport ${SECRET_POOL} for the pool.\n`, "pool.md"),
    [],
    "OPENCODE_GO_KEY_n= chunk dropped by the built-in denylist",
  );
  // Prose that merely NAMES the variable (no assignment) still indexes.
  const prose = chunkMarkdown(
    "## Notes\nThe DEEPINFRA_TOKEN config is documented in the profile.",
    "notes.md",
  );
  assert.equal(prose.length, 1, "prose naming a variable yields a chunk");
});

test("chunkMarkdown denyContent adds patterns on top of the built-ins", () => {
  const mixed = `## Clean\nBananas are a soft and sweet fruit.\n\n## Leak\nThe token is ${AWS_KEY} and must not be indexed.\n`;
  // Built-ins alone do not match the non-sk- token → both sections index.
  const all = chunkMarkdown(mixed, "mixed.md");
  assert.deepEqual(all.map((c) => c.title), ["Clean", "Leak"], "no config pattern → no filtering");
  // A configured pattern adds to the built-ins and drops only the match.
  const filtered = chunkMarkdown(mixed, "mixed.md", ["AKIA[0-9A-Z]{16}"]);
  assert.deepEqual(filtered.map((c) => c.title), ["Clean"], "only the matching chunk is dropped");
  assert.ok(!filtered[0].text.includes(AWS_KEY), "no key text survives");
});

test("RagEngine excludePaths skips glob matches and self-cleans on re-index", async (t) => {
  const { dir, docs } = await makeFixtureDir();
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  writeFileSync(join(docs, "ok.md"), "## Apples\nApples are crisp and sweet.\n");
  const secretDir = join(docs, "secrets");
  mkdirSync(secretDir, { recursive: true });
  writeFileSync(join(secretDir, "leak.md"), "## Leak\nclassified bananas are hidden here.\n");

  const storePath = join(dir, "store.sqlite");
  const databases = [{ name: "docs", path: docs, topK: 3 }];

  // First index WITHOUT filters: both files are ingested.
  const unfiltered = new RagEngine({ storePath, embedder: makeFakeEmbedder(32) });
  await unfiltered.ensureIndex(databases);
  const before = await unfiltered.query("classified bananas hidden", databases);
  assert.ok(
    before.length > 0 && before[0].results.some((r) => r.path.endsWith("secrets/leak.md")),
    "leak.md indexed before exclusion",
  );

  // Re-index WITH excludePaths: the walk drops secrets/ and the removal loop
  // deletes the stale chunks of the disappeared path.
  const filtered = new RagEngine({
    storePath,
    embedder: makeFakeEmbedder(32),
    filters: { excludePaths: ["**/secrets/**"] },
  });
  await filtered.ensureIndex(databases);
  const after = await filtered.query("classified bananas hidden", databases);
  assert.ok(
    !(after.length > 0 && after[0].results.some((r) => r.path.endsWith("secrets/leak.md"))),
    "leak.md chunks removed after the path is excluded",
  );
  const stillOk = await filtered.query("apples crisp sweet fruit", databases);
  assert.ok(
    stillOk.length > 0 && stillOk[0].results.some((r) => r.path.endsWith("ok.md")),
    "ok.md remains queryable",
  );
});

test("RagEngine ignoreDotfiles omits dotfiles only when enabled", async (t) => {
  const { dir, docs } = await makeFixtureDir();
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  writeFileSync(join(docs, "ok.md"), "## Apples\nApples are crisp and sweet.\n");
  // No secret tokens here: exclusion must come from ignoreDotfiles, not the
  // content denylist.
  writeFileSync(join(docs, ".env.md"), "## Env\nthe apple env file documents variables.\n");
  const databases = [{ name: "docs", path: docs, topK: 3 }];

  // Default (ignoreDotfiles false): .env.md IS walked and indexed.
  const defStore = join(dir, "default.sqlite");
  const defEngine = new RagEngine({ storePath: defStore, embedder: makeFakeEmbedder(32) });
  await defEngine.ensureIndex(databases);
  const defSections = await defEngine.query("apple env file documents", databases);
  assert.ok(
    defSections.length > 0 && defSections[0].results.some((r) => r.path.endsWith(".env.md")),
    "dotfile indexed by default (current behaviour)",
  );

  // ignoreDotfiles true: .env.md skipped; ok.md untouched.
  const filtStore = join(dir, "filtered.sqlite");
  const filtEngine = new RagEngine({
    storePath: filtStore,
    embedder: makeFakeEmbedder(32),
    filters: { ignoreDotfiles: true },
  });
  await filtEngine.ensureIndex(databases);
  const filtSections = await filtEngine.query("apple env file documents", databases);
  assert.ok(
    !(filtSections.length > 0 && filtSections[0].results.some((r) => r.path.endsWith(".env.md"))),
    "dotfile skipped when ignoreDotfiles is true",
  );
  const okSections = await filtEngine.query("apples crisp sweet fruit", databases);
  assert.ok(
    okSections.length > 0 && okSections[0].results.some((r) => r.path.endsWith("ok.md")),
    "ok.md still indexed with ignoreDotfiles on",
  );
});

test("RagEngine never embeds a denied chunk (denyContent scrub before embedding)", async (t) => {
  const { dir, docs } = await makeFixtureDir();
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  writeFileSync(join(docs, "creds.md"), `## Credentials\napiKey=${SECRET_KEY}\n`);
  writeFileSync(join(docs, "notes.md"), "## Notes\nBananas are a soft and sweet fruit.\n");

  const storePath = join(dir, "store.sqlite");
  const databases = [{ name: "docs", path: docs, topK: 3 }];

  const seen = [];
  const baseEmbedder = makeFakeEmbedder(32);
  const recordingEmbedder = async (texts) => {
    seen.push(...texts);
    return baseEmbedder(texts);
  };

  const engine = new RagEngine({ storePath, embedder: recordingEmbedder });
  const counts = await engine.ensureIndex(databases);

  assert.ok(counts.docs > 0, "the legit file still indexes");
  assert.ok(
    !seen.some((text) => text.includes(SECRET_KEY)),
    "the denied chunk text never reaches the embedder",
  );

  const sections = await engine.query("api key credentials", databases);
  const leaked = sections.some((s) =>
    s.results.some((r) => r.excerpt.includes(SECRET_KEY)),
  );
  assert.ok(!leaked, "no secret text in any stored/returned chunk");
});

// ---------------------------------------------------------------------------
// Rebuild idempotency + concurrency (post-window rag_index UNIQUE fix)
// ---------------------------------------------------------------------------

/**
 * A delayed fake embedder: keeps the deterministic vectors but widens the
 * async window between workers, exercising the ensureIndex serialization
 * (the boot auto-index, the `rag_index` tool and a racing query share the
 * same engine).
 */
function makeSlowFakeEmbedder(dim, delayMs = 60) {
  const base = makeFakeEmbedder(dim);
  return async (texts) => {
    await new Promise((r) => setTimeout(r, delayMs));
    return base(texts);
  };
}

test("RagEngine clear rebuild is idempotent (rag_index twice, no rowid collision)", async (t) => {
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

  // First pass: incremental build.
  const first = await engine.ensureIndex(databases);
  assert.ok(first.docs > 0, `first run indexes chunks: ${JSON.stringify(first)}`);

  // `rag_index` contract: a rebuild must regenerate a clean store, so a
  // second (and third) rebuild must never reuse stale rowids — the
  // pre-fix failure was "UNIQUE constraint failed on chunks primary key".
  const second = await engine.ensureIndex(databases, { clear: true });
  assert.equal(second.docs, first.docs, "rebuild produces the same chunk counts");
  const third = await engine.ensureIndex(databases, { clear: true });
  assert.equal(third.docs, first.docs, "a rebuild after a rebuild is stable");

  const sections = await engine.query("apples bananas oranges", databases);
  assert.equal(sections.length, 1, "one non-empty section after repeated rebuilds");
  assert.ok(sections[0].results.length >= 3, "all chunks queryable after repeated rebuilds");
});

test("RagEngine concurrent ensureIndex calls serialize without rowid collision", async (t) => {
  const { dir, docs } = await makeFixtureDir();
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  writeFileSync(
    join(docs, "one.md"),
    "## Apples\nApples are a crisp and sweet fruit that grows on trees.\n\n## Bananas\nBananas are a soft and sweet fruit that grows in bunches.\n",
  );
  writeFileSync(join(docs, "two.md"), "Oranges are a citrus fruit full of vitamin C and very juicy.\n");

  const storePath = join(dir, "store.sqlite");
  const engine = new RagEngine({ storePath, embedder: makeSlowFakeEmbedder(32) });
  const databases = [{ name: "docs", path: docs, topK: 3 }];

  // Boot auto-index + a racing caller (`rag_index` rebuild): the rebuild
  // must wait for the in-flight pass. Pre-fix, two interleaved passes over
  // one store derived the same explicit rowids and tripped the vec0
  // UNIQUE primary-key constraint.
  const [incremental, rebuilt] = await Promise.all([
    engine.ensureIndex(databases),
    engine.ensureIndex(databases, { clear: true }),
  ]);
  assert.equal(incremental.docs, rebuilt.docs, "both callers settle on the same chunk counts");

  const sections = await engine.query("apples bananas oranges", databases);
  assert.equal(sections.length, 1, "one non-empty section after the serialized passes");
  assert.ok(sections[0].results.length >= 3, "all chunks queryable after the serialized passes");
});

test("RagEngine rebuilds with denylisted secrets twice without rowid collision", async (t) => {
  const { dir, docs } = await makeFixtureDir();
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  // The denylist case: a document whose secret-bearing chunks are FILTERED
  // OUT before embedding, leaving only the safe sections in the store.
  writeFileSync(
    join(docs, "creds.md"),
    `## Secret Pool\nSet ${SECRET_KEY} as the active key now and export ${SECRET_ENV} to the environment.\n\n## Safe Notes\nBananas are a soft and sweet fruit that grows in bunches.\n`,
  );

  const storePath = join(dir, "store.sqlite");
  const databases = [{ name: "docs", path: docs, topK: 3 }];

  const seen = [];
  const baseEmbedder = makeFakeEmbedder(32);
  const recordingEmbedder = async (texts) => {
    seen.push(...texts);
    return baseEmbedder(texts);
  };
  const engine = new RagEngine({ storePath, embedder: recordingEmbedder });

  // Two rebuild passes (the `rag_index` tool contract): neither may trip the
  // UNIQUE primary-key constraint, and the final chunks are exactly the
  // expected safe ones.
  const first = await engine.ensureIndex(databases, { clear: true });
  const second = await engine.ensureIndex(databases, { clear: true });
  assert.equal(first.docs, 1, "only the safe chunk survives the denylist");
  assert.equal(second.docs, 1, "the rebuild reproduces the same safe chunk");

  const sections = await engine.query("bananas soft sweet fruit", databases);
  assert.equal(sections.length, 1, "one non-empty section");
  assert.ok(sections[0].results.length > 0, "the safe chunk is queryable");
  const leaked = sections.some((s) =>
    s.results.some((r) => r.excerpt.includes(SECRET_KEY) || r.excerpt.includes("DEEPSEEK_API_KEY=")),
  );
  assert.ok(!leaked, "no secret text in any result after the rebuilds");
  assert.ok(
    !seen.some((text) => text.includes(SECRET_KEY)),
    "the denied chunk text never reaches the embedder",
  );
});

// ---------------------------------------------------------------------------
// Per-file isolation (RAG engine hardening): one file's insert failure must
// never abort the whole pass (rollback that file → bounded re-base retry →
// skip with a log), and the H1 vec0 diagnostic (rowid/MAX/chunk_id, metadata
// only — never chunk_text or vectors) must be logged at the failure point.
// ---------------------------------------------------------------------------

test("RagEngine isolates a persistently failing file (skip + log) and continues the pass", async (t) => {
  const { dir, docs } = await makeFixtureDir();
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  // A poisoned file whose embedder yields 33-dim vectors for a FLOAT[32]
  // store: vec0 rejects the insert deterministically ("Dimension mismatch"),
  // so both per-file attempts fail and the file must be SKIPPED — the boot
  // pass keeps indexing the healthy files and never aborts.
  writeFileSync(join(docs, "poisoned.md"), "## Poisoned\nApples are crisp and sweet.\n");
  writeFileSync(join(docs, "ok-a.md"), "## A\nBananas are a soft and sweet fruit.\n");
  writeFileSync(join(docs, "ok-b.md"), "## B\nOranges are a citrus fruit with vitamin C.\n");

  const storePath = join(dir, "store.sqlite");
  const databases = [{ name: "docs", path: docs, topK: 3 }];
  const baseEmbedder = makeFakeEmbedder(32);
  const poisonedEmbedder = async (texts) => {
    if (texts.length === 1 && texts[0] === "probe") return baseEmbedder(texts);
    if (texts.some((x) => x.includes("poisoned"))) {
      return texts.map(() => new Array(33).fill(0.1)); // FLOAT[32] mismatch → in-tx throw
    }
    return baseEmbedder(texts);
  };
  const logs = [];
  const engine = new RagEngine({
    storePath,
    embedder: poisonedEmbedder,
    logger: (m) => logs.push(m),
  });

  const counts = await engine.ensureIndex(databases); // must NOT throw
  assert.ok(counts.docs > 0, `healthy files indexed: ${JSON.stringify(counts)}`);

  // The pass continued: healthy chunks are queryable.
  const sections = await engine.query("bananas oranges", databases);
  assert.equal(sections.length, 1, "one non-empty section");
  assert.ok(sections[0].results.length >= 2, "both healthy files queryable");

  // The poisoned file was retried ONCE, then skipped with the H1 diagnostic.
  const retried = logs.filter((m) => m.includes("rag: retrying") && m.includes("poisoned.md"));
  const skipped = logs.filter((m) => m.includes("rag: skipping") && m.includes("poisoned.md"));
  assert.equal(retried.length, 1, "exactly one bounded retry logged");
  assert.equal(skipped.length, 1, "persistent failure logged as a skip");
  assert.ok(skipped[0].includes("rowid="), "H1 diagnostic rowid present");
  assert.ok(skipped[0].includes("existing_chunk_id="), "H1 diagnostic chunk_id present");
  assert.ok(skipped[0].includes("max_rowid="), "H1 diagnostic MAX(rowid) present");
  assert.match(skipped[0], /Dimension mismatch/, "the underlying failure is logged");

  // The file was NOT recorded in the ledger (its mtime was left untouched), so
  // the next boot retries it: a healed pass over the same store indexes it.
  const healed = new RagEngine({ storePath, embedder: baseEmbedder });
  const healedCounts = await healed.ensureIndex(databases);
  assert.ok(healedCounts.docs > counts.docs, `healed pass indexes the skipped file: ${JSON.stringify(healedCounts)}`);
});

/**
 * A barrier embedder SHARED by two RagEngine instances: all `parties` must
 * reach their chunk-batch embed before any of them proceeds. Each engine
 * computes its rowid base (MAX(rowid)+1 on the shared store) BEFORE this
 * barrier, so both racers derive the same next rowid and the second inserter
 * deterministically trips the vec0 UNIQUE primary-key constraint — the exact
 * production error ("UNIQUE constraint failed on chunks primary key") — which
 * per-file isolation must contain (rollback → re-base retry → pass continues).
 */
function makeBarrierEmbedder(dim, parties, baseEmbedder) {
  let arrived = 0;
  let release;
  const gate = new Promise((r) => {
    release = r;
  });
  return async (texts) => {
    if (texts.length === 1 && texts[0] === "probe") return baseEmbedder(texts);
    arrived += 1;
    if (arrived === parties) release();
    await gate;
    return baseEmbedder(texts);
  };
}

test("RagEngine isolates a UNIQUE rowid collision to one file (re-base retry) and the pass continues", async (t) => {
  const { dir, docs } = await makeFixtureDir();
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  writeFileSync(join(docs, "seed.md"), "## Seed\nSeeds grow into plants with leaves.\n");
  const dirA = join(dir, "dbA");
  const dirB = join(dir, "dbB");
  mkdirSync(dirA, { recursive: true });
  mkdirSync(dirB, { recursive: true });

  const storePath = join(dir, "store.sqlite");
  const base = makeFakeEmbedder(32);
  // Seed one committed chunk so the racing passes start from MAX(rowid) = 1.
  await new RagEngine({ storePath, embedder: base }).ensureIndex([
    { name: "seed", path: docs, topK: 3 },
  ]);

  const allLogs = [];
  for (let round = 1; round <= 2; round++) {
    const fA = join(dirA, `fA-${round}.md`);
    const fB = join(dirB, `fB-${round}.md`);
    writeFileSync(
      fA,
      `## Alpha ${round}\nAlpha fruit is sweet and crisp and round.\n\n## Beta ${round}\nBeta berries are small and tart.\n`,
    );
    writeFileSync(fB, `## Gamma ${round}\nGamma melons are large and juicy.\n`);

    // One SHARED barrier embedder: both racers must reach the file embed
    // before either inserts — their MAX reads already happened, so both use
    // the same next rowid and exactly one of them collides (different
    // db_name, different source_path → no shared delete frees the rowid).
    const barrier = makeBarrierEmbedder(32, 2, base);
    const engineA = new RagEngine({
      storePath,
      embedder: barrier,
      logger: (m) => allLogs.push(m),
    });
    const engineB = new RagEngine({
      storePath,
      embedder: barrier,
      logger: (m) => allLogs.push(m),
    });
    const [countsA, countsB] = await Promise.all([
      engineA.ensureIndex([{ name: "dA", path: dirA, topK: 3 }]),
      engineB.ensureIndex([{ name: "dB", path: dirB, topK: 3 }]),
    ]);
    assert.ok(countsA.dA >= 2, `round ${round}: db A indexed: ${JSON.stringify(countsA)}`);
    assert.ok(countsB.dB >= 1, `round ${round}: db B indexed: ${JSON.stringify(countsB)}`);
  }

  // The deterministic race produced at least one UNIQUE collision, recovered
  // via the re-base retry (the H1 diagnostic line is emitted at the failure).
  const uniqueLogs = allLogs.filter((m) =>
    m.includes("UNIQUE constraint failed on chunks primary key"),
  );
  assert.ok(uniqueLogs.length >= 1, `at least one UNIQUE collision logged (got ${uniqueLogs.length})`);
  assert.ok(
    uniqueLogs.some((m) =>
      m.includes("rowid=") && m.includes("max_rowid=") && m.includes("existing_chunk_id="),
    ),
    "H1 diagnostic fields present in the UNIQUE log",
  );
  assert.ok(
    allLogs.some((m) => m.includes("rag: retrying") && m.includes("UNIQUE constraint failed")),
    "re-base retry after the UNIQUE collision is logged",
  );

  // Final store consistency: nothing was lost and nothing double-indexed.
  const finalRun = new RagEngine({ storePath, embedder: base });
  const finalCounts = await finalRun.ensureIndex([
    { name: "seed", path: docs, topK: 3 },
    { name: "dA", path: dirA, topK: 3 },
    { name: "dB", path: dirB, topK: 3 },
  ]);
  // seed 1 chunk + 2 rounds × (dbA 2 chunks + dbB 1 chunk) = 7.
  assert.equal(
    finalCounts.seed + finalCounts.dA + finalCounts.dB,
    7,
    `total chunk counts consistent: ${JSON.stringify(finalCounts)}`,
  );
  const sections = await finalRun.query("alpha beta gamma melon", [
    { name: "seed", path: docs, topK: 3 },
    { name: "dA", path: dirA, topK: 3 },
    { name: "dB", path: dirB, topK: 3 },
  ]);
  assert.equal(sections.length, 3, "all three databases queryable after the collisions");
  assert.ok(
    sections.every((s) => s.results.length > 0),
    "each database returns results",
  );
});
