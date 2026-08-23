import { test } from "node:test";
import assert from "node:assert/strict";

import {
  buildParallelExtractBody,
  joinParallelExcerpts,
  extractParallelContent,
  findParallelExtractResult,
  registerParallelExtractProvider,
  ParallelExtractProvider,
  PARALLEL_EXTRACT_API_URL,
  PARALLEL_EXTRACT_MAX_URLS,
  PARALLEL_EXTRACT_MODE_DEFAULT,
  PARALLEL_EXTRACT_PROVIDER_ID,
  PARALLEL_EXTRACT_TIMEOUT_MS,
} from "../lib/index.js";

// ---------------------------------------------------------------------------
// Handy fixtures
// ---------------------------------------------------------------------------

/** A fake `Response`-like object carrying a canned JSON body. */
function makeExtractResponse(resultItem, ok = true, status = 200) {
  return {
    ok,
    status,
    async json() {
      return { results: [resultItem] };
    },
  };
}

/**
 * A stub fetch that swallows the upstream `AbortSignal` so the provider's own
 * timeout can abort it (used only to prove the timeout backstop fires).
 */
function makeAbortAwareFetch() {
  return (url, opts) =>
    new Promise((resolve, reject) => {
      const signal = opts && opts.signal;
      const listener = () => reject(signal.reason ?? new Error("aborted"));
      if (signal.aborted) return reject(signal.reason ?? new Error("aborted"));
      signal.addEventListener("abort", listener, { once: true });
      // Deliberately never resolves: only the abort can settle the promise.
    });
}

/** `available()`-matching provider with the literal key set. */
function makeProvider(overrides = {}) {
  return new ParallelExtractProvider({
    enabled: true,
    apiKey: "test-key-123",
    apiKeyEnv: "PARALLEL_EXTRACT_TEST_UNSET",
    extractMode: "full",
    timeoutMs: 60000,
    ...overrides,
  });
}

let restoredFetch = null;
function stubFetch(fn) {
  if (restoredFetch === null) restoredFetch = globalThis.fetch;
  globalThis.fetch = fn;
}
function restoreFetch() {
  if (restoredFetch !== null) {
    globalThis.fetch = restoredFetch;
    restoredFetch = null;
  }
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

test("provider id is 'parallel-extract'", () => {
  assert.equal(PARALLEL_EXTRACT_PROVIDER_ID, "parallel-extract");
});

test("extract endpoint is the Parallel Extract API URL", () => {
  assert.equal(PARALLEL_EXTRACT_API_URL, "https://api.parallel.ai/v1/extract");
});

test("the per-request URL cap is 20", () => {
  assert.equal(PARALLEL_EXTRACT_MAX_URLS, 20);
});

test("the default extractMode is 'full'", () => {
  assert.equal(PARALLEL_EXTRACT_MODE_DEFAULT, "full");
});

test("the default extract timeout is 60000 ms", () => {
  assert.equal(PARALLEL_EXTRACT_TIMEOUT_MS, 60000);
});

// ---------------------------------------------------------------------------
// buildParallelExtractBody — request body + the 20-URL limit
// ---------------------------------------------------------------------------

test("buildParallelExtractBody builds a 'full' body with one URL", () => {
  const body = buildParallelExtractBody(["https://example.com/a"], "full");
  assert.deepEqual(body, {
    urls: ["https://example.com/a"],
    advanced_settings: { full_content: true },
  });
});

test("buildParallelExtractBody preserves multiple URLs in input order", () => {
  const body = buildParallelExtractBody(
    ["https://a.example", "https://b.example", "https://c.example"],
    "full",
  );
  assert.deepEqual(body.urls, ["https://a.example", "https://b.example", "https://c.example"]);
});

test("buildParallelExtractBody sets full_content false for 'snippets'", () => {
  const body = buildParallelExtractBody(["https://example.com/a"], "snippets");
  assert.equal(body.advanced_settings.full_content, false);
});

test("buildParallelExtractBody throws on an empty URL batch", () => {
  assert.throws(
    () => buildParallelExtractBody([], "full"),
    (err) => err.code === "WEB_PROVIDER_ERROR",
  );
});

test("buildParallelExtractBody enforces the 20-URL per-request limit", () => {
  const tooMany = Array.from({ length: PARALLEL_EXTRACT_MAX_URLS + 1 }, (_, i) => `https://e.example/${i}`);
  assert.throws(
    () => buildParallelExtractBody(tooMany, "full"),
    (err) => err.code === "WEB_PROVIDER_ERROR" && /at most 20 URLs/.test(err.message),
  );
});

test("buildParallelExtractBody accepts exactly 20 URLs", () => {
  const ok = Array.from({ length: PARALLEL_EXTRACT_MAX_URLS }, (_, i) => `https://e.example/${i}`);
  const body = buildParallelExtractBody(ok, "full");
  assert.equal(body.urls.length, PARALLEL_EXTRACT_MAX_URLS);
});

test("buildParallelExtractBody honours a custom maxUrls cap", () => {
  assert.throws(
    () => buildParallelExtractBody(["a", "b", "c", "d"], "full", 3),
    (err) => err.code === "WEB_PROVIDER_ERROR" && /at most 3 URLs/.test(err.message),
  );
  assert.equal(buildParallelExtractBody(["a", "b", "c"], "full", 3).urls.length, 3);
});

// ---------------------------------------------------------------------------
// joinParallelExcerpts
// ---------------------------------------------------------------------------

test("joinParallelExcerpts joins non-empty excerpts with a blank line", () => {
  assert.equal(joinParallelExcerpts(["first", "second"]), "first\n\nsecond");
});

test("joinParallelExcerpts filters empty and non-string entries", () => {
  assert.equal(joinParallelExcerpts(["a", "", "  ", "b", 42]), "a\n\nb");
});

test("joinParallelExcerpts returns undefined for an empty array", () => {
  assert.equal(joinParallelExcerpts([]), undefined);
});

test("joinParallelExcerpts returns undefined for absent excerpts", () => {
  assert.equal(joinParallelExcerpts(undefined), undefined);
});

// ---------------------------------------------------------------------------
// extractParallelContent — mapping the document to the provider output
// ---------------------------------------------------------------------------

test("extractParallelContent returns full_content in 'full' mode", () => {
  assert.equal(
    extractParallelContent({ full_content: "# Doc\n\nbody" }, "full"),
    "# Doc\n\nbody",
  );
});

test("extractParallelContent falls back to excerpts when full_content is null", () => {
  assert.equal(
    extractParallelContent({ full_content: null, excerpts: ["e1", "e2"] }, "full"),
    "e1\n\ne2",
  );
});

test("extractParallelContent falls back to excerpts when full_content is missing", () => {
  assert.equal(
    extractParallelContent({ excerpts: ["only excerpt"] }, "full"),
    "only excerpt",
  );
});

test("extractParallelContent joins excerpts in 'snippets' mode", () => {
  assert.equal(
    extractParallelContent({ full_content: "# Doc", excerpts: ["s1", "s2"] }, "snippets"),
    "s1\n\ns2",
  );
});

test("extractParallelContent returns undefined when no content is available", () => {
  assert.equal(extractParallelContent({}, "full"), undefined);
  assert.equal(extractParallelContent({ full_content: null, excerpts: [] }, "snippets"), undefined);
});

// ---------------------------------------------------------------------------
// findParallelExtractResult — locating the item for the requested URL
// ---------------------------------------------------------------------------

test("findParallelExtractResult matches the URL exactly", () => {
  const item = { url: "https://example.com/a", full_content: "# A" };
  assert.equal(findParallelExtractResult({ results: [item] }, "https://example.com/a"), item);
});

test("findParallelExtractResult is trailing-slash-insensitive", () => {
  const item = { url: "https://example.com/a/", full_content: "# A" };
  assert.equal(findParallelExtractResult({ results: [item] }, "https://example.com/a"), item);
});

test("findParallelExtractResult falls back to a single result", () => {
  const item = { url: "https://example.com/a", full_content: "# A" };
  assert.equal(findParallelExtractResult({ results: [item] }, "https://redirected.example"), item);
});

test("findParallelExtractResult returns undefined when multiple results do not match", () => {
  const result = findParallelExtractResult(
    { results: [{ url: "https://x.example" }, { url: "https://y.example" }] },
    "https://z.example",
  );
  assert.equal(result, undefined);
});

test("findParallelExtractResult returns undefined for no results", () => {
  assert.equal(findParallelExtractResult({ results: [] }, "https://example.com"), undefined);
  assert.equal(findParallelExtractResult({}, "https://example.com"), undefined);
});

// ---------------------------------------------------------------------------
// ParallelExtractProvider.available() — usability gating
// ---------------------------------------------------------------------------

test("available() is false without a resolvable key", () => {
  const provider = makeProvider({ apiKey: "", apiKeyEnv: "PARALLEL_EXTRACT_TEST_UNSET" });
  assert.equal(provider.available(), false);
});

test("available() is false when the provider is disabled", () => {
  const provider = makeProvider({ enabled: false, apiKey: "k" });
  assert.equal(provider.available(), false);
});

test("available() is true when enabled with a key", () => {
  assert.equal(makeProvider().available(), true);
});

test("available() trims the literal key before the availability check", () => {
  const provider = makeProvider({ apiKey: "  spaces  " });
  assert.equal(provider.available(), true);
});

// ---------------------------------------------------------------------------
// ParallelExtractProvider.fetch — correct request (full mode)
// ---------------------------------------------------------------------------

test("fetch issues a POST to the Parallel Extract API", async () => {
  let captured;
  stubFetch((url) => {
    captured = url;
    return makeExtractResponse({ url: "https://example.com/a", full_content: "# A" });
  });
  try {
    await makeProvider().fetch({ url: "https://example.com/a" });
  } finally {
    restoreFetch();
  }
  assert.equal(captured, PARALLEL_EXTRACT_API_URL);
});

test("fetch sends the x-api-key and content-type headers", async () => {
  let captured;
  stubFetch((url, opts) => {
    captured = opts;
    return makeExtractResponse({ url: "https://example.com/a", full_content: "# A" });
  });
  try {
    await makeProvider().fetch({ url: "https://example.com/a" });
  } finally {
    restoreFetch();
  }
  assert.equal(captured.method, "POST");
  assert.equal(captured.headers["x-api-key"], "test-key-123");
  assert.equal(captured.headers["Content-Type"], "application/json");
});

test("fetch sends the body with urls and full_content at 'full' mode", async () => {
  let captured;
  stubFetch((url, opts) => {
    captured = opts;
    return makeExtractResponse({ url: "https://example.com/a", full_content: "# A" });
  });
  try {
    await makeProvider().fetch({ url: "https://example.com/a" });
  } finally {
    restoreFetch();
  }
  const body = JSON.parse(captured.body);
  assert.deepEqual(body.urls, ["https://example.com/a"]);
  assert.deepEqual(body.advanced_settings, { full_content: true });
});

test("fetch maps the full_content document to a text body result", async () => {
  stubFetch(() => makeExtractResponse({ url: "https://example.com/a", title: "A", full_content: "# Hello\n\nworld" }));
  try {
    const result = await makeProvider().fetch({ url: "https://example.com/a" });
    assert.equal(result.url, "https://example.com/a");
    assert.equal(result.statusCode, 200);
    assert.equal(result.body.kind, "text");
    assert.equal(result.body.content, "# Hello\n\nworld");
    assert.equal(result.truncated, false);
  } finally {
    restoreFetch();
  }
});

// ---------------------------------------------------------------------------
// ParallelExtractProvider.fetch — correct request + mapping (snippets mode)
// ---------------------------------------------------------------------------

test("fetch sends full_content false in 'snippets' mode", async () => {
  let captured;
  stubFetch((url, opts) => {
    captured = opts;
    return makeExtractResponse({ url: "https://example.com/a", excerpts: ["e1", "e2"] });
  });
  try {
    await makeProvider({ extractMode: "snippets" }).fetch({ url: "https://example.com/a" });
  } finally {
    restoreFetch();
  }
  assert.equal(JSON.parse(captured.body).advanced_settings.full_content, false);
});

test("fetch maps joined excerpts to the text body in 'snippets' mode", async () => {
  stubFetch(() => makeExtractResponse({ url: "https://example.com/a", excerpts: ["e1", "e2"] }));
  try {
    const result = await makeProvider({ extractMode: "snippets" }).fetch({ url: "https://example.com/a" });
    assert.equal(result.body.kind, "text");
    assert.equal(result.body.content, "e1\n\ne2");
  } finally {
    restoreFetch();
  }
});

// ---------------------------------------------------------------------------
// ParallelExtractProvider.fetch — URL hygiene (no network)
// ---------------------------------------------------------------------------

test("fetch rejects a non-http scheme without calling the API", async () => {
  let called = false;
  stubFetch(() => {
    called = true;
    return makeExtractResponse({ url: "file:///etc/passwd" });
  });
  try {
    await assert.rejects(
      makeProvider().fetch({ url: "file:///etc/passwd" }),
      (err) => err.code === "WEB_INVALID_URL",
    );
  } finally {
    restoreFetch();
  }
  assert.equal(called, false, "the API must not be called for a non-web URL");
});

test("fetch rejects credentials in the URL", async () => {
  await assert.rejects(
    makeProvider().fetch({ url: "https://user:pass@example.com/a" }),
    (err) => err.code === "WEB_BLOCKED_URL",
  );
});

test("fetch rejects an invalid URL", async () => {
  await assert.rejects(
    makeProvider().fetch({ url: "not-a-url" }),
    (err) => err.code === "WEB_INVALID_URL",
  );
});

// ---------------------------------------------------------------------------
// ParallelExtractProvider.fetch — degradation (soft WebError failures)
// ---------------------------------------------------------------------------

test("fetch fails cleanly (WEB_PROVIDER_ERROR) without a key", async () => {
  const provider = makeProvider({ apiKey: "", apiKeyEnv: "PARALLEL_EXTRACT_TEST_UNSET" });
  await assert.rejects(
    provider.fetch({ url: "https://example.com/a" }),
    (err) => err.code === "WEB_PROVIDER_ERROR" && /no API key resolved/.test(err.message),
  );
});

test("fetch fails cleanly (WEB_PROVIDER_ERROR) when the provider is disabled", async () => {
  const provider = makeProvider({ enabled: false, apiKey: "k" });
  await assert.rejects(provider.fetch({ url: "https://example.com/a" }), (err) => err.code === "WEB_PROVIDER_ERROR");
});

test("fetch degrades on an HTTP 401", async () => {
  stubFetch(() => makeExtractResponse({ url: "https://example.com/a" }, false, 401));
  try {
    await assert.rejects(makeProvider().fetch({ url: "https://example.com/a" }), (err) => err.code === "WEB_PROVIDER_ERROR");
  } finally {
    restoreFetch();
  }
});

test("fetch degrades on an HTTP 500", async () => {
  stubFetch(() => makeExtractResponse({ url: "https://example.com/a" }, false, 500));
  try {
    await assert.rejects(makeProvider().fetch({ url: "https://example.com/a" }), (err) => err.code === "WEB_PROVIDER_ERROR");
  } finally {
    restoreFetch();
  }
});

test("fetch degrades on a malformed response (no results array)", async () => {
  stubFetch(() => ({ ok: true, status: 200, json: async () => ({}) }));
  try {
    await assert.rejects(makeProvider().fetch({ url: "https://example.com/a" }), (err) => err.code === "WEB_PROVIDER_ERROR");
  } finally {
    restoreFetch();
  }
});

test("fetch degrades when the URL is absent from results (reported in errors[]) — no fetch-call to the URL", async () => {
  stubFetch(() => ({
    ok: true,
    status: 200,
    json: async () => ({ results: [], errors: [{ url: "https://example.com/a", error: "not found" }] }),
  }));
  try {
    await assert.rejects(makeProvider().fetch({ url: "https://example.com/a" }), (err) => err.code === "WEB_PROVIDER_ERROR" && /no result for/.test(err.message));
  } finally {
    restoreFetch();
  }
});

test("fetch degrades when the document has no content", async () => {
  stubFetch(() => makeExtractResponse({ url: "https://example.com/a", full_content: null, excerpts: [] }));
  try {
    await assert.rejects(makeProvider().fetch({ url: "https://example.com/a" }), (err) => err.code === "WEB_PROVIDER_ERROR" && /no content for/.test(err.message));
  } finally {
    restoreFetch();
  }
});

test("fetch degrades (WEB_PROVIDER_ERROR) on a network error", async () => {
  stubFetch(() => {
    throw new Error("network down");
  });
  try {
    await assert.rejects(makeProvider().fetch({ url: "https://example.com/a" }), (err) => err.code === "WEB_PROVIDER_ERROR" && /network down/.test(err.message));
  } finally {
    restoreFetch();
  }
});

test("fetch aborts cleanly (WEB_ABORTED) on an already-aborted signal", async () => {
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    makeProvider().fetch({ url: "https://example.com/a" }, controller.signal),
    (err) => err.code === "WEB_ABORTED",
  );
});

test("fetch's own timeout backstop fires and surfaces as WEB_FETCH_TIMEOUT", async () => {
  stubFetch(makeAbortAwareFetch());
  try {
    const provider = makeProvider({ timeoutMs: 30 });
    await assert.rejects(provider.fetch({ url: "https://example.com/a" }), (err) => err.code === "WEB_FETCH_TIMEOUT");
  } finally {
    restoreFetch();
  }
});

// ---------------------------------------------------------------------------
// registerParallelExtractProvider — registration into the web seam
// ---------------------------------------------------------------------------

function fakeWeb(register) {
  return {
    registerFetchProvider(provider) {
      if (register) register(provider);
      return () => {};
    },
  };
}

function fakeCtx(web) {
  const effects = [];
  return {
    get: (key) => (key === "web" ? web : undefined),
    effect: (fn, label) => {
      effects.push({ fn, label });
      return undefined;
    },
    effects,
  };
}

test("registerParallelExtractProvider is a no-op when disabled", () => {
  let registered = false;
  const ctx = fakeCtx(fakeWeb(() => {
    registered = true;
  }));
  registerParallelExtractProvider(ctx, {
    enabled: false,
    apiKeyEnv: "PARALLEL_API_KEY",
    apiKey: "k",
  });
  assert.equal(registered, false);
});

test("registerParallelExtractProvider is a no-op when the web seam is absent", () => {
  const ctx = fakeCtx(undefined);
  registerParallelExtractProvider(ctx, {
    enabled: true,
    apiKeyEnv: "PARALLEL_API_KEY",
    apiKey: "k",
  });
  assert.equal(ctx.effects.length, 0);
});

test("registerParallelExtractProvider registers the provider with the seam", () => {
  let provider;
  const ctx = fakeCtx(fakeWeb((p) => {
    provider = p;
  }));
  registerParallelExtractProvider(ctx, {
    enabled: true,
    apiKeyEnv: "PARALLEL_API_KEY",
    apiKey: "k",
  });
  assert.ok(provider instanceof ParallelExtractProvider);
  assert.equal(provider.id, "parallel-extract");
  assert.equal(ctx.effects.length, 1);
});
