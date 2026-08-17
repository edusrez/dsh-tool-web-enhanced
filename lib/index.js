import z from "@deepseek-ai/schemastery";
import { defineTool } from "@deepseek-ai/dsh-tools";
import { applyWebFetchTool, formatSearchOutput, presentSearchCall, presentSearchResult, searchMetaFromValue, DEFAULT_WEB_TOOL_TIMEOUT_MS, DEFAULT_FETCH_MAX_OUTPUT_CHARS, } from "@deepseek-ai/dsh-tool-web";
import { RagEngine } from "./rag.js";
import { buildSections, resolveSourcesParameter, } from "./modules.js";
/**
 * `dsh-tool-web-enhanced` — a drop-in enhancement of
 * `@deepseek-ai/dsh-tool-web` that ONLY enhances `web_search`.
 *
 * It layers optional native-result sections (SearXNG, RAG) under the stock
 * DeepSeek search results, selected via the `sections` config container and
 * the `sources` parameter. `web_fetch` is registered IDENTICALLY to stock
 * (reused via {@link applyWebFetchTool}), so its behaviour is byte-for-byte
 * unchanged. When no section is configured/enabled/unreachable, `web_search`
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
// Re-exports for docs/tests
// ---------------------------------------------------------------------------
export { buildSections, createRagSection, createSearxngSection, DEFAULT_SEARXNG_URL, SEARXNG_SNIPPET_MAX_CHARS, TOPIC_CATEGORIES, formatSearxngOutput, mapSearxngResults, mapSearxngSource, resolveSourcesParameter, topicToCategory, truncateSnippet, } from "./modules.js";
// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------
/**
 * Plugin configuration. Extends the stock `dsh-tool-web` keys (which keep
 * identical names and defaults) with a unified `sections` container replacing
 * the former flat top-level search/RAG keys (breaking change).
 */
export const Config = z.object({
    search: z.boolean().default(true),
    fetch: z.boolean().default(true),
    searchMaxResults: z.number().default(8),
    fetchTimeoutMs: z.number().default(DEFAULT_WEB_TOOL_TIMEOUT_MS),
    searchTimeoutMs: z.number().default(DEFAULT_WEB_TOOL_TIMEOUT_MS),
    fetchMaxOutputChars: z.number().default(DEFAULT_FETCH_MAX_OUTPUT_CHARS),
    sections: z.object({
        searxng: z.object({
            enabled: z.boolean().default(true),
            url: z.string().default('http://127.0.0.1:8080'),
        }).default({}),
        rag: z.object({
            enabled: z.boolean().default(true),
            storePath: z.string().default(''),
            embeddings: z.object({
                provider: z.union([z.const('auto'), z.const('remote'), z.const('local')]).default('auto'),
                apiKeyEnv: z.string().default('EMBEDDING_API_KEY'),
                apiKey: z.string().default(''),
                model: z.string().default('BAAI/bge-m3'),
                baseURL: z.string().default('https://api.deepinfra.com/v1/openai'),
                localModel: z.string().default('Xenova/bge-small-en-v1.5'),
            }).default({}),
            databases: z.array(z.object({
                name: z.string(),
                path: z.string(),
                topK: z.number().default(5),
            })).default([]),
        }).default({}),
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
 * collapse the `auto` provider to a concrete `remote`/`local` choice, and
 * resolve the API key (literal wins, then the environment variable).
 *
 * @param rag - the raw `sections.rag` config from the schema.
 * @returns the resolved RAG configuration.
 */
export function resolveRag(rag) {
    const storePath = rag.storePath.trim().length > 0
        ? rag.storePath
        : `${process.env.DSH_HOME ?? process.cwd()}/storages/rag/rag.db`;
    const key = rag.embeddings.apiKey.trim().length > 0
        ? rag.embeddings.apiKey
        : (process.env[rag.embeddings.apiKeyEnv] ?? '');
    const provider = rag.embeddings.provider === 'remote'
        ? 'remote'
        : rag.embeddings.provider === 'local'
            ? 'local'
            : key.length > 0
                ? 'remote'
                : 'local';
    return {
        enabled: rag.enabled,
        storePath,
        embeddings: {
            provider,
            apiKeyEnv: rag.embeddings.apiKeyEnv,
            apiKey: key,
            model: rag.embeddings.model,
            baseURL: rag.embeddings.baseURL,
            localModel: rag.embeddings.localModel,
        },
        databases: rag.databases,
    };
}
/**
 * Maximum number of input texts sent to a remote provider per embeddings
 * request. Some remote providers return HTTP 500 on very large single
 * batches, so `createEmbedder` slices the corpus into bounded requests
 * instead of sending everything at once.
 */
export const REMOTE_EMBEDDING_BATCH_SIZE = 16;
/**
 * Split `items` into consecutive, order-preserving batches of at most `size`
 * elements. The last batch is shorter when `items.length` is not a multiple
 * of `size`; an empty input yields no batches.
 *
 * @param items - the items to split (any element type).
 * @param size - the maximum batch size (must be a positive integer).
 * @returns the batches, in input order.
 */
export function chunkBatches(items, size) {
    const batches = [];
    for (let i = 0; i < items.length; i += size) {
        batches.push(items.slice(i, i + size));
    }
    return batches;
}
/** A cached local transformers.js feature-extraction pipeline, keyed by model. */
let localPipelineCache;
/**
 * Build an {@link Embedder} for the resolved RAG embeddings config.
 *
 * `remote`: POSTs the inputs in bounded batches (max
 * {@link REMOTE_EMBEDDING_BATCH_SIZE} texts each) to `<baseURL>/embeddings`
 * (an embeddings-API-compatible endpoint) and returns `data[].embedding` in
 * input order. `local`: lazily loads a transformers.js feature-extraction
 * pipeline (singleton per model, `q8` quantization) and returns
 * `Array.from(out.data)` for each input text.
 *
 * @param embeddings - the resolved embeddings config (concrete provider + key).
 * @returns an async `(texts) => vectors` embedder.
 */
export function createEmbedder(embeddings) {
    if (embeddings.provider === 'remote') {
        const baseURL = embeddings.baseURL.replace(/\/+$/, '');
        return async (texts) => {
            // Some remote providers fail (HTTP 500) when a single request carries a
            // whole corpus, so POST bounded batches and reassemble in input order.
            const vectors = [];
            for (const batch of chunkBatches(texts, REMOTE_EMBEDDING_BATCH_SIZE)) {
                const response = await fetch(`${baseURL}/embeddings`, {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        Authorization: `Bearer ${embeddings.apiKey}`,
                    },
                    body: JSON.stringify({
                        model: embeddings.model,
                        input: batch,
                        encoding_format: 'float',
                    }),
                });
                if (!response.ok) {
                    throw new Error(`remote embeddings request failed: ${response.status}`);
                }
                const body = (await response.json());
                if (!Array.isArray(body.data)) {
                    throw new Error('remote embeddings response missing data array');
                }
                for (const d of body.data)
                    vectors.push(d.embedding ?? []);
            }
            return vectors;
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
/**
 * Render a `SectionBlock` as one markdown block. Each source renders as
 * `- **<title-or-hostname>** — <url or path> (score X)` with the snippet on
 * its own indented line when present.
 *
 * @param block - the section block to render.
 * @returns the `## <name>` markdown block, or an empty string when empty.
 */
export function formatSectionBlock(block) {
    if (block.sources.length === 0)
        return "";
    const lines = block.sources.map((s) => {
        let label;
        if (s.title !== undefined && s.title.length > 0)
            label = s.title;
        else {
            try {
                label = new URL(s.url).hostname;
            }
            catch {
                label = s.url;
            }
        }
        const target = s.path ?? s.url;
        let head = `- **${label}** — ${target}`;
        if (s.score !== undefined)
            head += ` (score ${s.score.toFixed(3)})`;
        if (s.snippet !== undefined && s.snippet.length > 0) {
            head += `\n  ${s.snippet}`;
        }
        return head;
    });
    return `## ${block.name}\n${lines.join("\n")}`;
}
/**
 * Render the complete enhanced output: the stock native block (via
 * {@link formatSearchOutput}) followed by each section block in order.
 *
 * @param value - the canonical enhanced output value.
 * @returns the combined model-facing text.
 */
export function formatEnhancedSearchOutput(value) {
    const parts = [formatSearchOutput(value)];
    if (value.sections !== undefined) {
        for (const block of value.sections) {
            const text = formatSectionBlock(block);
            if (text.length > 0)
                parts.push(text);
        }
    }
    return parts.filter((p) => p.length > 0).join("\n\n");
}
/**
 * Register the enhanced `web_search` tool.
 *
 * Identical to the stock registration except: (a) an optional `topic`
 * parameter forwarded to the SearXNG section as a category filter, (b) a
 * generalized `sections` array in the output schema carrying each selected
 * section's blocks, and (c) a dynamic `sources` parameter. When no section is
 * enabled/selected/unreachable the value, render, and presentation meta are
 * byte-for-byte the stock behaviour.
 *
 * @param ctx - context whose `tools`, `web`, and `systemPrompt` seam receive
 *   the registrations; both are effect-scoped and unregister on dispose.
 * @param maxResults - the deployment source cap (native + sections).
 * @param timeoutMs - the cooperative tool-call budget (ms).
 * @param fetchEnabled - whether `web_fetch` is also exposed (drives guidance).
 * @param sections - the enabled sections (from {@link buildSections}).
 */
function applyEnhancedWebSearchTool(ctx, maxResults, timeoutMs, fetchEnabled, sections) {
    ctx.systemPrompt.section({
        name: "tool:web_search",
        order: 110,
        text: fetchEnabled
            ? "Use the web_search tool to discover current information on the web. It returns an optional answer plus a list of source URLs (native results, plus the optional installed result sections; select which with the optional sources parameter). Follow up with web_fetch when you need the full content of a specific result, and cite the relevant URLs as markdown links."
            : "Use the web_search tool to discover current information on the web. It returns an optional answer plus a list of source URLs (native results, plus the optional installed result sections; select which with the optional sources parameter). Use the returned source snippets when available, and cite the relevant URLs as markdown links.",
    });
    ctx.tools.register(defineTool({
        name: "web_search",
        description: "Search the web for current information. Returns an optional summary answer and a list of source URLs, plus the optional installed result sections.",
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
                description: "Comma-separated list of result sources to include: native plus any enabled section id (default: all). native = DeepSeek native results. Any combination, e.g. 'native,rag' or 'searxng'.",
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
                    sections: {
                        type: "array",
                        items: {
                            type: "object",
                            additionalProperties: false,
                            properties: {
                                name: { type: "string", required: true },
                                sources: {
                                    type: "array",
                                    items: {
                                        type: "object",
                                        additionalProperties: false,
                                        properties: {
                                            url: { type: "string", required: true },
                                            title: { type: "string" },
                                            snippet: { type: "string" },
                                            score: { type: "number" },
                                            path: { type: "string" },
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
            const wanted = resolveSourcesParameter(args.sources, sections);
            const value = {
                sources: [],
                truncated: false,
            };
            if (wanted.native) {
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
            const blocks = [];
            for (const section of sections) {
                if (!section.enabled)
                    continue;
                if (!wanted.sections.has(section.id))
                    continue;
                try {
                    const produced = await section.run(query, {
                        maxResults,
                        topic: args.topic,
                        sources: wanted.sections,
                        signal: exec.signal,
                    });
                    if (produced !== undefined)
                        blocks.push(...produced);
                }
                catch (err) {
                    // Any section failure degrades silently: omit that section.
                    console.error(`[dsh-tool-web-enhanced] section '${section.id}' failed:`, err);
                }
            }
            if (blocks.length > 0)
                value.sections = blocks;
            return value;
        },
        presentCall: presentSearchCall,
        presentResult: (args, result) => presentSearchResult(args, result),
    }));
}
// ---------------------------------------------------------------------------
// Application
// ---------------------------------------------------------------------------
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
    const rag = resolveRag(resolved.sections.rag);
    const ragEngine = rag.enabled && rag.databases.length > 0
        ? new RagEngine({
            storePath: rag.storePath,
            embedder: createEmbedder(rag.embeddings),
            logger: (m) => console.log("[dsh-tool-web-enhanced] " + m),
        })
        : undefined;
    // Build the enabled sections once at boot (in config order).
    const sections = buildSections({ searxng: resolved.sections.searxng, rag: { enabled: rag.enabled, databases: rag.databases } }, { ragEngine, searxngTimeoutMs: resolved.searchTimeoutMs });
    // The RAG section is the only one exposing an index accessor.
    const ragSection = sections.find((s) => s.id === "rag");
    if (ragEngine !== undefined && ragSection !== undefined) {
        // Boot auto-index: async, non-blocking — failures are logged, not thrown.
        ragSection.ensureIndex(rag.databases).catch((e) => {
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
                const counts = await ragSection.ensureIndex(rag.databases);
                return { indexed: counts };
            },
        }));
    }
    if (resolved.search) {
        applyEnhancedWebSearchTool(ctx, resolved.searchMaxResults, resolved.searchTimeoutMs, resolved.fetch, sections);
    }
    if (resolved.fetch) {
        // Reuse the stock fetch registration verbatim — web_fetch is unchanged.
        applyWebFetchTool(ctx, resolved.fetchTimeoutMs, resolved.fetchMaxOutputChars);
    }
}
//# sourceMappingURL=index.js.map