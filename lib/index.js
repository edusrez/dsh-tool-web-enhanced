import z from "@deepseek-ai/schemastery";
import { defineTool } from "@deepseek-ai/dsh-tools";
import { applyWebFetchTool, formatSearchOutput, presentSearchCall, presentSearchResult, searchMetaFromValue, DEFAULT_WEB_TOOL_TIMEOUT_MS, DEFAULT_FETCH_MAX_OUTPUT_CHARS, } from "@deepseek-ai/dsh-tool-web";
import { RagEngine, parseSources } from "./rag.js";
/**
 * `dsh-tool-web-enhanced` — a drop-in enhancement of
 * `@deepseek-ai/dsh-tool-web` that ONLY enhances `web_search`.
 *
 * It layers an optional SearXNG native section under the stock DeepSeek
 * search results, and adds an optional `topic` vertical filter mapped to
 * SearXNG `categories`. `web_fetch` is registered IDENTICALLY to stock
 * (reused via {@link applyWebFetchTool}), so its behaviour is byte-for-byte
 * unchanged. When SearXNG is absent, disabled, or unreachable, `web_search`
 * degrades silently to exactly the stock behaviour and output shape.
 *
 * @module dsh-tool-web-enhanced
 */
// ---------------------------------------------------------------------------
// Plugin identity
// ---------------------------------------------------------------------------
/** Cordis plugin name (distinct from the stock `"tool-web"`). */
export const name = "tool-web-enhanced";
/** Services required: the same seam as the stock tool-web plugin. */
export const inject = ["tools", "web", "systemPrompt"];
// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------
/**
 * Default SearXNG base URL. SearXNG is optional: an empty/falsy `searxngUrl`
 * config value disables the SearXNG section entirely (native-only).
 */
export const DEFAULT_SEARXNG_URL = "http://127.0.0.1:8080";
/** Maximum snippet length (chars) retained from a SearXNG result's content. */
export const SEARXNG_SNIPPET_MAX_CHARS = 200;
// ---------------------------------------------------------------------------
// Topic → SearXNG categories mapping
// ---------------------------------------------------------------------------
/**
 * The set of `topic` values accepted on `web_search`, each mapped to the
 * SearXNG `categories` value it forwards to the JSON API. `topic` is purely a
 * SearXNG vertical filter: native DeepSeek results are unaffected.
 */
export const TOPIC_CATEGORIES = {
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
/**
 * Resolve an optional `topic` argument to the SearXNG `categories` value.
 *
 * @param topic - optional vertical from the `web_search` `topic` parameter.
 * @returns the mapped category, or `undefined` when the topic is absent or
 *   unrecognised (the caller then omits `categories`, falling back to
 *   SearXNG's default `general`).
 */
export function topicToCategory(topic) {
    if (topic === undefined)
        return undefined;
    const key = topic.trim();
    return Object.prototype.hasOwnProperty.call(TOPIC_CATEGORIES, key)
        ? TOPIC_CATEGORIES[key]
        : undefined;
}
/** Truncate a string to `max` characters, `…`-suffixed when cut. */
export function truncateSnippet(text, max) {
    if (text === undefined)
        return undefined;
    const trimmed = text.trim();
    if (trimmed.length === 0)
        return undefined;
    if (trimmed.length <= max)
        return trimmed;
    return `${trimmed.slice(0, max - 1)}…`;
}
/**
 * Map one raw SearXNG result item to the canonical source shape.
 *
 * @param item - a SearXNG JSON result item.
 * @returns a source with `url`, `title`, `snippet` (content truncated to
 *   {@link SEARXNG_SNIPPET_MAX_CHARS}), and `publishedAt` when present; skips
 *   a result that lacks a usable URL.
 */
export function mapSearxngSource(item) {
    if (typeof item.url !== "string" || item.url.trim().length === 0)
        return undefined;
    const source = { url: item.url };
    if (typeof item.title === "string" && item.title.trim().length > 0) {
        source.title = item.title.trim();
    }
    const snippet = truncateSnippet(item.content, SEARXNG_SNIPPET_MAX_CHARS);
    if (snippet !== undefined)
        source.snippet = snippet;
    if (typeof item.publishedDate === "string" && item.publishedDate.trim().length > 0) {
        source.publishedAt = item.publishedDate.trim();
    }
    return source;
}
/**
 * Map a SearXNG JSON result set to capped, canonical source objects.
 *
 * @param items - the SearXNG `results` array (may be missing/empty).
 * @param maxResults - the deployment source cap applied to the SearXNG section.
 * @returns up to `maxResults` valid sources, in result order.
 */
export function mapSearxngResults(items, maxResults) {
    if (!Array.isArray(items))
        return [];
    const out = [];
    for (const item of items) {
        if (out.length >= maxResults)
            break;
        const mapped = mapSearxngSource(item);
        if (mapped !== undefined)
            out.push(mapped);
    }
    return out;
}
/**
 * Fetch one SearXNG results page from the JSON API. Never throws: any
 * failure (network, timeout, non-2xx, invalid JSON) resolves to `undefined`
 * so the caller can silently fall back to native-only results.
 *
 * The call is bounded by a local `timeoutMs` timer that aborts an internal
 * AbortController, composed with the caller's `signal`: an external abort
 * aborts the same controller with the external reason. Whichever fires
 * first wins, so the bound holds whether or not a `signal` is provided.
 *
 * @param baseUrl - the configured SearXNG base URL.
 * @param query - the search query (URL-encoded by the caller).
 * @param category - the resolved SearXNG `categories` value, or `undefined`.
 * @param signal - the tool execution signal (cancellation/timeout); optional.
 * @param timeoutMs - the local timeout budget for this call (ms).
 * @returns the mapped sources, or `undefined` on any failure.
 */
export async function fetchSearxng(baseUrl, query, category, signal, timeoutMs) {
    const url = new URL("/search", baseUrl);
    url.searchParams.set("q", query);
    url.searchParams.set("format", "json");
    if (category !== undefined)
        url.searchParams.set("categories", category);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(new DOMException("SearXNG timeout", "TimeoutError")), timeoutMs);
    const onExternalAbort = () => controller.abort(signal?.reason);
    if (signal !== undefined) {
        if (signal.aborted) {
            controller.abort(signal.reason);
        }
        else {
            signal.addEventListener("abort", onExternalAbort, { once: true });
        }
    }
    try {
        const response = await fetch(url.toString(), {
            signal: controller.signal,
            headers: { accept: "application/json" },
        });
        if (!response.ok)
            return undefined;
        const body = (await response.json());
        if (typeof body !== "object" || body === null || !Array.isArray(body.results)) {
            return undefined;
        }
        return body.results;
    }
    catch {
        return undefined;
    }
    finally {
        clearTimeout(timeout);
        if (signal !== undefined) {
            signal.removeEventListener("abort", onExternalAbort);
        }
    }
}
/**
 * Render the SearXNG section as one markdown block. Reuses the exact
 * `- [title](url) — snippet (publishedAt)` shape of the stock formatter.
 *
 * @param sources - the SearXNG sources (already mapped + capped).
 * @returns a `## SearXNG results` markdown block, or an empty string when
 *   there are no SearXNG sources.
 */
export function formatSearxngOutput(sources) {
    if (sources.length === 0)
        return "";
    const lines = sources.map((source) => {
        let label;
        if (source.title !== undefined && source.title.length > 0)
            label = source.title;
        else {
            try {
                label = new URL(source.url).hostname;
            }
            catch {
                label = source.url;
            }
        }
        const meta = [];
        if (source.snippet !== undefined && source.snippet.length > 0)
            meta.push(source.snippet);
        if (source.publishedAt !== undefined && source.publishedAt.length > 0)
            meta.push(`(${source.publishedAt})`);
        const suffix = meta.length > 0 ? ` — ${meta.join(" ")}` : "";
        return `- [${label}](${source.url})${suffix}`;
    });
    return `## SearXNG results\n${lines.join("\n")}`;
}
/**
 * Render the RAG sections: one `## <name> (RAG)` block per section, each
 * result as `- **title** — path (score …)` with the excerpt on its own
 * indented line.
 *
 * @param sections - the RAG sections (from {@link RagEngine.query}).
 * @returns the combined markdown, or an empty string when there are none.
 */
export function formatRagOutput(sections) {
    if (sections === undefined || sections.length === 0)
        return "";
    const blocks = sections.map((section) => {
        const lines = section.results.map((r) => {
            const head = `- **${r.title}** — ${r.path} (score ${r.score.toFixed(3)})`;
            const excerpt = r.excerpt.trim();
            return excerpt.length > 0 ? `${head}\n  ${excerpt}` : head;
        });
        return `## ${section.name} (RAG)\n${lines.join("\n")}`;
    });
    return blocks.join("\n\n");
}
/**
 * Render the complete enhanced output: the stock native block (via
 * {@link formatSearchOutput}) followed by the SearXNG block when present.
 *
 * @param value - the canonical enhanced output value.
 * @returns the combined model-facing text.
 */
export function formatEnhancedSearchOutput(value) {
    const native = formatSearchOutput(value);
    const searxng = value.searxngSources !== undefined ? formatSearxngOutput(value.searxngSources) : "";
    const rag = formatRagOutput(value.rag);
    const parts = [native, searxng, rag].filter((p) => p.length > 0);
    return parts.join("\n\n");
}
// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------
/**
 * Plugin configuration. Extends the stock `dsh-tool-web` keys (which keep
 * identical names and defaults) with the optional SearXNG-driven keys.
 */
export const Config = z.object({
    search: z.boolean().default(true),
    fetch: z.boolean().default(true),
    searchMaxResults: z.number().default(8),
    fetchTimeoutMs: z.number().default(DEFAULT_WEB_TOOL_TIMEOUT_MS),
    searchTimeoutMs: z.number().default(DEFAULT_WEB_TOOL_TIMEOUT_MS),
    fetchMaxOutputChars: z.number().default(DEFAULT_FETCH_MAX_OUTPUT_CHARS),
    searxngUrl: z.string().default(DEFAULT_SEARXNG_URL),
    searxngEnabled: z.boolean().default(true),
    rag: z.object({
        enabled: z.boolean().default(true),
        storePath: z.string().default(''),
        embeddings: z.object({
            provider: z.union([z.const('auto'), z.const('deepinfra'), z.const('local')]).default('auto'),
            apiKeyEnv: z.string().default('DEEPINFRA_TOKEN'),
            apiKey: z.string().default(''),
            deepinfraModel: z.string().default('BAAI/bge-m3'),
            deepinfraBaseURL: z.string().default('https://api.deepinfra.com/v1/openai'),
            localModel: z.string().default('Xenova/bge-small-en-v1.5'),
        }).default({}),
        databases: z.array(z.object({
            name: z.string(),
            path: z.string(),
            topK: z.number().default(5),
        })).default([]),
    }).default({}),
});
/** Configured count and timeout caps must be positive integers. */
function assertPositiveInteger(label, value) {
    if (!Number.isInteger(value) || value < 1) {
        throw new Error(`tool-web-enhanced: ${label} must be a positive integer`);
    }
}
/**
 * Resolve the raw RAG config into concrete values: default the store path,
 * collapse the `auto` provider to a concrete `deepinfra`/`local` choice, and
 * resolve the API key (literal wins, then the environment variable).
 *
 * @param rag - the raw `rag` config from the schema.
 * @returns the resolved RAG configuration.
 */
export function resolveRag(rag) {
    const storePath = rag.storePath.trim().length > 0
        ? rag.storePath
        : `${process.env.DSH_HOME ?? process.cwd()}/storages/rag/rag.db`;
    const key = rag.embeddings.apiKey.trim().length > 0
        ? rag.embeddings.apiKey
        : (process.env[rag.embeddings.apiKeyEnv] ?? '');
    const provider = rag.embeddings.provider === 'deepinfra'
        ? 'deepinfra'
        : rag.embeddings.provider === 'local'
            ? 'local'
            : key.length > 0
                ? 'deepinfra'
                : 'local';
    return {
        enabled: rag.enabled,
        storePath,
        embeddings: {
            provider,
            apiKeyEnv: rag.embeddings.apiKeyEnv,
            apiKey: key,
            deepinfraModel: rag.embeddings.deepinfraModel,
            deepinfraBaseURL: rag.embeddings.deepinfraBaseURL,
            localModel: rag.embeddings.localModel,
        },
        databases: rag.databases,
    };
}
/** A cached local transformers.js feature-extraction pipeline, keyed by model. */
let localPipelineCache;
/**
 * Build an {@link Embedder} for the resolved RAG embeddings config.
 *
 * `deepinfra`: POSTs a batch to `<deepinfraBaseURL>/embeddings` (OpenAI
 * compatible) and returns `data[].embedding` in input order. `local`: lazily
 * loads a `@huggingface/transformers` feature-extraction pipeline (singleton
 * per model, `q8` quantization) and returns `Array.from(out.data)` for each
 * input text.
 *
 * @param embeddings - the resolved embeddings config (concrete provider + key).
 * @returns an async `(texts) => vectors` embedder.
 */
export function createEmbedder(embeddings) {
    if (embeddings.provider === 'deepinfra') {
        const baseURL = embeddings.deepinfraBaseURL.replace(/\/+$/, '');
        return async (texts) => {
            const response = await fetch(`${baseURL}/embeddings`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    Authorization: `Bearer ${embeddings.apiKey}`,
                },
                body: JSON.stringify({
                    model: embeddings.deepinfraModel,
                    input: texts,
                    encoding_format: 'float',
                }),
            });
            if (!response.ok) {
                throw new Error(`deepinfra embeddings request failed: ${response.status}`);
            }
            const body = (await response.json());
            if (!Array.isArray(body.data)) {
                throw new Error('deepinfra embeddings response missing data array');
            }
            return body.data.map((d) => d.embedding ?? []);
        };
    }
    // local
    return async (texts) => {
        let pipeline;
        try {
            if (localPipelineCache === undefined || localPipelineCache.model !== embeddings.localModel) {
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                const mod = await import('@huggingface/transformers');
                const p = await mod.pipeline('feature-extraction', embeddings.localModel, { dtype: 'q8' });
                localPipelineCache = { model: embeddings.localModel, pipeline: p };
            }
            pipeline = localPipelineCache.pipeline;
        }
        catch (err) {
            throw new Error(`local embeddings need the optional dependency @huggingface/transformers — npm i @huggingface/transformers (${err.message})`);
        }
        const vectors = [];
        for (const text of texts) {
            const out = await pipeline(text, { pooling: 'mean', normalize: true });
            vectors.push(Array.from(out.data));
        }
        return vectors;
    };
}
// ---------------------------------------------------------------------------
// Application
// ---------------------------------------------------------------------------
/**
 * Register the enhanced `web_search` tool.
 *
 * Identical to the stock registration except: (a) an optional `topic`
 * parameter mapped to SearXNG `categories`, (b) a second, optional SearXNG
 * results section appended to the native results, and (c) a
 * `searxngSources` field in the output schema carrying that section. When
 * SearXNG is disabled/unreachable the value, render, and presentation meta
 * are byte-for-byte the stock behaviour.
 *
 * @param ctx - context whose `tools` and `systemPrompt` registries receive the
 *   registrations; both are effect-scoped and unregister on plugin dispose.
 * @param maxResults - the deployment source cap (native + SearXNG sections).
 * @param timeoutMs - the cooperative tool-call budget (ms).
 * @param fetchEnabled - whether `web_fetch` is also exposed (drives guidance).
 * @param searxng - resolved SearXNG options ({ enabled, url }).
 * @param rag - resolved RAG options ({ active, engine, databases }).
 */
function applyEnhancedWebSearchTool(ctx, maxResults, timeoutMs, fetchEnabled, searxng, rag) {
    const searxngActive = searxng.enabled && searxng.url.trim().length > 0;
    const ragActive = rag.active && rag.engine !== undefined && rag.databases.length > 0;
    ctx.systemPrompt.section({
        name: "tool:web_search",
        order: 110,
        text: fetchEnabled
            ? "Use the web_search tool to discover current information on the web. It returns an optional answer plus a list of source URLs (native results, plus an optional SearXNG section and optional local RAG sections; select which with the optional sources parameter). Follow up with web_fetch when you need the full content of a specific result, and cite the relevant URLs as markdown links."
            : "Use the web_search tool to discover current information on the web. It returns an optional answer plus a list of source URLs (native results, plus an optional SearXNG section and optional local RAG sections; select which with the optional sources parameter). Use the returned source snippets when available, and cite the relevant URLs as markdown links.",
    });
    ctx.tools.register(defineTool({
        name: "web_search",
        description: "Search the web for current information. Returns an optional summary answer and a list of source URLs, plus an optional SearXNG results section.",
        parameters: {
            query: {
                type: "string",
                required: true,
                description: "The search query.",
            },
            topic: {
                type: "string",
                description: "Optional vertical to filter the SearXNG results section. Allowed: general, news, science, it, files, social media, images, videos, map, music. Native DeepSeek results are unaffected.",
            },
            sources: {
                type: "string",
                description: "Comma-separated list of result sources to include: native, searxng, rag (default: all). native = DeepSeek native results; searxng = the SearXNG section; rag = local RAG database sections. Any combination, e.g. 'native,rag' or 'searxng'.",
            },
        },
        output: {
            schema: {
                type: "object",
                additionalProperties: false,
                properties: {
                    content: { type: "string" },
                    sources: {
                        type: "array",
                        required: true,
                        items: {
                            type: "object",
                            additionalProperties: false,
                            properties: {
                                url: { type: "string", required: true },
                                title: { type: "string" },
                                snippet: { type: "string" },
                                publishedAt: { type: "string" },
                            },
                        },
                    },
                    truncated: {
                        type: "boolean",
                        required: true,
                    },
                    searxngSources: {
                        type: "array",
                        items: {
                            type: "object",
                            additionalProperties: false,
                            properties: {
                                url: { type: "string", required: true },
                                title: { type: "string" },
                                snippet: { type: "string" },
                                publishedAt: { type: "string" },
                            },
                        },
                    },
                    rag: {
                        type: "array",
                        items: {
                            type: "object",
                            additionalProperties: false,
                            properties: {
                                name: { type: "string", required: true },
                                results: {
                                    type: "array",
                                    items: {
                                        type: "object",
                                        additionalProperties: false,
                                        properties: {
                                            title: { type: "string" },
                                            path: { type: "string", required: true },
                                            excerpt: { type: "string" },
                                            score: { type: "number" },
                                        },
                                    },
                                },
                            },
                        },
                    },
                },
            },
            render: (_args, value) => [{
                    type: "text",
                    text: formatEnhancedSearchOutput(value),
                }],
            // presentationMeta keeps producing the existing 'web'/'search' card with
            // NATIVE sources only (ToolResultView is a closed union) — reuse the
            // stock projector unchanged on the native-shaped part.
            presentationMeta: (_args, value) => searchMetaFromValue(value),
        },
        timeoutMs,
        isConcurrencySafe: () => true,
        async execute(args, exec) {
            const query = typeof args.query === "string" ? args.query : "";
            if (query.trim().length === 0) {
                throw new Error("query must be a non-empty string");
            }
            const srcs = parseSources(args.sources);
            const want = (token) => srcs === "all" || srcs.has(token);
            const value = {
                sources: [],
                truncated: false,
            };
            if (want("native")) {
                const native = await ctx.web.search({ query, maxResults }, exec.signal);
                if (native.content !== undefined)
                    value.content = native.content;
                value.sources = native.sources.map((s) => {
                    const out = { url: s.url };
                    if (s.title !== undefined)
                        out.title = s.title;
                    if (s.snippet !== undefined)
                        out.snippet = s.snippet;
                    if (s.publishedAt !== undefined)
                        out.publishedAt = s.publishedAt;
                    return out;
                });
                value.truncated = native.truncated;
            }
            if (want("searxng") && searxngActive) {
                const category = topicToCategory(args.topic);
                const raw = await fetchSearxng(searxng.url, query, category, exec.signal, timeoutMs);
                if (raw !== undefined) {
                    const mapped = mapSearxngResults(raw, maxResults);
                    if (mapped.length > 0)
                        value.searxngSources = mapped;
                }
            }
            if (want("rag") && ragActive) {
                try {
                    const sections = await rag.engine.query(query, rag.databases);
                    if (sections.length > 0)
                        value.rag = sections;
                }
                catch (err) {
                    // RAG errors degrade silently: omit the section.
                    console.error("[dsh-tool-web-enhanced] RAG query failed:", err);
                }
            }
            return value;
        },
        presentCall: presentSearchCall,
        presentResult: (args, result) => presentSearchResult(args, result),
    }));
}
/**
 * Register the enabled web tools. `web_search` is the enhanced variant;
 * `web_fetch` is reused from stock verbatim. All registrations are
 * effect-scoped (the registries clean up on plugin dispose).
 *
 * @param ctx - context whose `tools`, `web`, and `systemPrompt` seam receive
 *   the registrations.
 * @param config - the resolved configuration.
 */
export function apply(ctx, config) {
    const resolved = config;
    assertPositiveInteger("searchMaxResults", resolved.searchMaxResults);
    assertPositiveInteger("fetchTimeoutMs", resolved.fetchTimeoutMs);
    assertPositiveInteger("searchTimeoutMs", resolved.searchTimeoutMs);
    assertPositiveInteger("fetchMaxOutputChars", resolved.fetchMaxOutputChars);
    const rag = resolveRag(resolved.rag);
    const ragEngine = rag.enabled && rag.databases.length > 0
        ? new RagEngine({
            storePath: rag.storePath,
            embedder: createEmbedder(rag.embeddings),
            logger: (m) => console.log("[dsh-tool-web-enhanced] " + m),
        })
        : undefined;
    if (ragEngine !== undefined) {
        // Boot auto-index: async, non-blocking — failures are logged, not thrown.
        ragEngine.ensureIndex(rag.databases).catch((e) => {
            console.error("[dsh-tool-web-enhanced] initial RAG index failed:", e);
        });
        ctx.tools.register(defineTool({
            name: "rag_index",
            description: "Rebuild the local RAG index for all configured databases. Returns the number of chunks indexed per database.",
            parameters: {},
            output: {
                schema: {
                    type: "object",
                    additionalProperties: false,
                    properties: {
                        indexed: { type: "object", required: true, additionalProperties: true },
                    },
                },
                render: (_args, value) => [{ type: "text", text: JSON.stringify(value) }],
            },
            timeoutMs: 300000,
            isConcurrencySafe: () => false,
            async execute() {
                const counts = await ragEngine.ensureIndex(rag.databases);
                return { indexed: counts };
            },
        }));
    }
    if (resolved.search) {
        applyEnhancedWebSearchTool(ctx, resolved.searchMaxResults, resolved.searchTimeoutMs, resolved.fetch, { enabled: resolved.searxngEnabled, url: resolved.searxngUrl }, { active: rag.enabled, engine: ragEngine, databases: rag.databases });
    }
    if (resolved.fetch) {
        // Reuse the stock fetch registration verbatim — web_fetch is unchanged.
        applyWebFetchTool(ctx, resolved.fetchTimeoutMs, resolved.fetchMaxOutputChars);
    }
}
//# sourceMappingURL=index.js.map