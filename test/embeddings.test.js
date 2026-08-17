import { test } from "node:test";
import assert from "node:assert/strict";

import {
  chunkBatches,
  REMOTE_EMBEDDING_BATCH_SIZE,
  createEmbedder,
} from "../lib/index.js";

// ---------------------------------------------------------------------------
// chunkBatches
// ---------------------------------------------------------------------------

test("chunkBatches splits in order with a shorter last batch", () => {
  const items = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9];
  assert.deepEqual(chunkBatches(items, 4), [
    [0, 1, 2, 3],
    [4, 5, 6, 7],
    [8, 9],
  ]);
  // Exact multiple → no empty trailing batch.
  assert.deepEqual(chunkBatches([1, 2, 3, 4], 2), [
    [1, 2],
    [3, 4],
  ]);
  // Empty input → no batches.
  assert.deepEqual(chunkBatches([], 16), []);
  // Single batch smaller than the size.
  assert.deepEqual(chunkBatches(["a", "b"], 16), [["a", "b"]]);
  // Generic element type preserved (objects, not strings).
  const objs = [{ id: 1 }, { id: 2 }, { id: 3 }];
  assert.deepEqual(chunkBatches(objs, 2), [[{ id: 1 }, { id: 2 }], [{ id: 3 }]]);
});

// ---------------------------------------------------------------------------
// createEmbedder (remote): bounded batches, order-preserving
// ---------------------------------------------------------------------------

/**
 * A fake `Response`-shaped object: `ok` plus an embeddings-shaped `data`
 * array whose `i`-th entry embeds the numeric input text into `[number]`, so
 * order is verifiable in the flattened result.
 */
function makeFakeResponse(batch) {
  return {
    ok: true,
    status: 200,
    async json() {
      return { data: batch.map((text) => ({ embedding: [Number(text)] })) };
    },
  };
}

test("remote embedder batches inputs (16/batch) and preserves order", async (t) => {
  const originalFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, init) => {
    const body = JSON.parse(init.body);
    calls.push({ url, body });
    return makeFakeResponse(body.input);
  };
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  const embedder = createEmbedder({
    provider: "remote",
    apiKeyEnv: "EMBEDDING_API_KEY",
    apiKey: "test-key",
    model: "test-embedding-model",
    baseURL: "https://embeddings.example.com/v1/openai/",
    localModel: "test-local-model",
  });

  const inputs = Array.from({ length: 40 }, (_, i) => String(i));
  const vectors = await embedder(inputs);

  // ceil(40 / 16) = 3 requests.
  assert.equal(calls.length, 3, "40 inputs → 3 batched requests");

  // Batch sizes: 16, 16, 8 — each in input order.
  assert.deepEqual(
    calls.map((c) => c.body.input),
    [
      inputs.slice(0, 16),
      inputs.slice(16, 32),
      inputs.slice(32, 40),
    ],
  );

  // The URL is `${baseURL}/embeddings` with the trailing slash stripped.
  assert.equal(calls[0].url, "https://embeddings.example.com/v1/openai/embeddings");

  // Request shape: embeddings-API-compatible payload.
  for (const call of calls) {
    assert.equal(call.body.model, "test-embedding-model");
    assert.equal(call.body.encoding_format, "float");
    assert.ok(call.body.input.length <= REMOTE_EMBEDDING_BATCH_SIZE);
  }

  // Returned vectors are flattened in input order: [[0],[1],…,[39]].
  assert.equal(vectors.length, 40);
  assert.deepEqual(
    vectors.map((v) => v[0]),
    Array.from({ length: 40 }, (_, i) => i),
  );
});

test("remote embedder throws the existing message shape on non-2xx", async (t) => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: false, status: 500 });
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  const embedder = createEmbedder({
    provider: "remote",
    apiKeyEnv: "EMBEDDING_API_KEY",
    apiKey: "test-key",
    model: "test-embedding-model",
    baseURL: "https://embeddings.example.com/v1/openai",
    localModel: "test-local-model",
  });

  await assert.rejects(
    embedder(["one", "two"]),
    /remote embeddings request failed: 500/,
  );
});

test("remote embedder skips fetch for empty input", async (t) => {
  const originalFetch = globalThis.fetch;
  let fetchCalls = 0;
  globalThis.fetch = async () => {
    fetchCalls += 1;
    return makeFakeResponse([]);
  };
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  const embedder = createEmbedder({
    provider: "remote",
    apiKeyEnv: "EMBEDDING_API_KEY",
    apiKey: "test-key",
    model: "test-embedding-model",
    baseURL: "https://embeddings.example.com/v1/openai",
    localModel: "test-local-model",
  });

  assert.deepEqual(await embedder([]), []);
  assert.equal(fetchCalls, 0, "no requests for an empty input list");
});
