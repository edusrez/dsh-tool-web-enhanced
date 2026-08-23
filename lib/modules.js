/**
 * `dsh-tool-web-enhanced` — modular search sections.
 *
 * The `web_search` enhancement is built from pluggable **sections**: each
 * section contributes an optional block of sources (native results are always
 * handled by the stock formatter; the extra slices — SearXNG, RAG — are
 * sections). A section implements the {@link SearchSection} interface and is
 * activated from the `sections` config container via {@link buildSections}.
 *
 * This module owns the section interface and the built-in section factories
 * (SearXNG and RAG). The RAG engine itself lives in `./rag.js` and is kept
 * unchanged — {@link createRagSection} only wires a {@link RagEngine} into the
 * section lifecycle.
 *
 * @module dsh-tool-web-enhanced/modules
 */
import { DEFAULT_WEB_TOOL_TIMEOUT_MS } from "@deepseek-ai/dsh-tool-web";
import { WebError } from "@deepseek-ai/dsh-web";
// ---------------------------------------------------------------------------
// SearXNG section
// ---------------------------------------------------------------------------
/**
 * Default SearXNG base URL. SearXNG is optional: an empty/falsy `url` config
 * value disables the SearXNG section entirely (native-only).
 */
export const DEFAULT_SEARXNG_URL = "http://127.0.0.1:8080";
/** Maximum snippet length (chars) retained from a SearXNG result's content. */
export const SEARXNG_SNIPPET_MAX_CHARS = 200;
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
 * Map one raw SearXNG result item to a {@link SectionSource}.
 *
 * @param item - a SearXNG JSON result item.
 * @returns a source with `url`, `title`, `snippet` (content truncated to
 *   {@link SEARXNG_SNIPPET_MAX_CHARS}); skips a result that lacks a usable URL.
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
 * @returns the raw SearXNG result items, or `undefined` on any failure.
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
 * Render a SearXNG sources block (used by tests / tooling).
 *
 * @param sources - the mapped SearXNG sources.
 * @returns a `## SearXNG results` markdown block, or an empty string when
 *   there are no sources.
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
        const suffix = source.snippet !== undefined && source.snippet.length > 0
            ? ` — ${source.snippet}`
            : "";
        return `- **${label}** — ${source.url}${suffix}`;
    });
    return `## SearXNG results\n${lines.join("\n")}`;
}
/**
 * Build the SearXNG search section.
 *
 * @param config - the SearXNG config slice: `{ enabled, url }` (plus an
 *   optional internal `timeoutMs` for the per-call bound).
 * @returns the configured SearXNG section.
 */
export function createSearxngSection(config) {
    const timeoutMs = config.timeoutMs ?? DEFAULT_WEB_TOOL_TIMEOUT_MS;
    return {
        id: "searxng",
        enabled: config.enabled,
        async run(query, ctx) {
            const active = config.enabled && config.url.trim().length > 0;
            if (!active)
                return undefined;
            const category = topicToCategory(ctx.topic);
            const raw = await fetchSearxng(config.url, query, category, ctx.signal, timeoutMs);
            if (raw === undefined)
                return undefined;
            const sources = mapSearxngResults(raw, ctx.maxResults);
            if (sources.length === 0)
                return undefined;
            return [{ name: "SearXNG results", sources }];
        },
    };
}
// ---------------------------------------------------------------------------
// Parallel section (Parallel Web Systems Search API)
// ---------------------------------------------------------------------------
/** Parallel Search API endpoint. */
export const PARALLEL_API_URL = "https://api.parallel.ai/v1/search";
/** Default search mode (cheap/fast tier) used when no `mode` is configured. */
export const PARALLEL_MODE_DEFAULT = "fast";
/** Maximum snippet length (chars) retained from a Parallel result excerpt. */
export const PARALLEL_SNIPPET_MAX_CHARS = 600;
/** The maximum number of results the Parallel API returns per request. */
export const PARALLEL_MAX_RESULTS = 10;
/**
 * Derive the `search_queries` array sent to the Parallel API from a single
 * `web_search` `query`. The API accepts a single-query array; if a live
 * integration shows that it is rejected, switch to the deterministic
 * two-query fallback `[query, query + ' — recent news and analysis']` here.
 */
export function deriveParallelSearchQueries(query) {
    return [query];
}
/**
 * Pick the snippet for a Parallel result: the densest (longest) excerpt,
 * truncated to {@link PARALLEL_SNIPPET_MAX_CHARS}; falls back to the first
 * excerpt when present, or `undefined` when there are no excerpts.
 */
export function pickParallelSnippet(excerpts) {
    if (!Array.isArray(excerpts) || excerpts.length === 0)
        return undefined;
    let best = excerpts[0] ?? "";
    for (const excerpt of excerpts) {
        if (typeof excerpt === "string" && excerpt.length > best.length)
            best = excerpt;
    }
    return truncateSnippet(best, PARALLEL_SNIPPET_MAX_CHARS);
}
/**
 * Map one raw Parallel result item to a {@link SectionSource} (url, title,
 * snippet from the densest excerpt); skips a result that lacks a usable URL.
 */
export function mapParallelSource(item) {
    if (typeof item.url !== "string" || item.url.trim().length === 0)
        return undefined;
    const source = { url: item.url };
    if (typeof item.title === "string" && item.title.trim().length > 0) {
        source.title = item.title.trim();
    }
    const snippet = pickParallelSnippet(item.excerpts);
    if (snippet !== undefined)
        source.snippet = snippet;
    return source;
}
/**
 * Map a Parallel result set to capped, canonical source objects. Skips
 * results missing a usable URL; caps to `maxResults` in result order.
 */
export function mapParallelResults(items, maxResults) {
    if (!Array.isArray(items))
        return [];
    const out = [];
    for (const item of items) {
        if (out.length >= maxResults)
            break;
        const mapped = mapParallelSource(item);
        if (mapped !== undefined)
            out.push(mapped);
    }
    return out;
}
/**
 * Call the Parallel Search API once. Never throws: any failure (network,
 * timeout, non-2xx, invalid JSON) resolves to `undefined` so the caller can
 * silently omit the section. Bounded by a local `timeoutMs` timer composed
 * with the caller's `signal`, exactly like {@link fetchSearxng}.
 */
export async function fetchParallel(objective, searchQueries, mode, apiKey, signal, timeoutMs) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(new DOMException("Parallel timeout", "TimeoutError")), timeoutMs);
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
        const response = await fetch(PARALLEL_API_URL, {
            method: "POST",
            signal: controller.signal,
            headers: {
                "Content-Type": "application/json",
                "x-api-key": apiKey,
            },
            body: JSON.stringify({
                objective,
                search_queries: searchQueries,
                mode,
            }),
        });
        if (!response.ok)
            return undefined;
        const body = (await response.json());
        if (typeof body !== "object" || body === null || !Array.isArray(body.results)) {
            return undefined;
        }
        return body;
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
 * Build the Parallel search section.
 *
 * The section is inert (returns `undefined` without fetching) when no API key
 * resolves: the literal `apiKey` wins, else the `apiKeyEnv` environment
 * variable. `mode` defaults to {@link PARALLEL_MODE_DEFAULT} (`fast`).
 *
 * @param config - the Parallel config slice: `{ enabled, apiKey, apiKeyEnv,
 *   mode?, maxResults? }` plus an optional internal `timeoutMs` bound.
 * @returns the configured Parallel section.
 */
export function createParallelSection(config) {
    const timeoutMs = config.timeoutMs ?? DEFAULT_WEB_TOOL_TIMEOUT_MS;
    const mode = config.mode ?? PARALLEL_MODE_DEFAULT;
    const maxResults = config.maxResults ?? PARALLEL_MAX_RESULTS;
    return {
        id: "parallel",
        enabled: config.enabled,
        async run(query, ctx) {
            if (!config.enabled)
                return undefined;
            const key = config.apiKey.trim().length > 0
                ? config.apiKey
                : (process.env[config.apiKeyEnv] ?? "");
            if (key.length === 0)
                return undefined; // inert without a key — no fetch
            const raw = await fetchParallel(query, deriveParallelSearchQueries(query), mode, key, ctx.signal, timeoutMs);
            if (raw === undefined)
                return undefined;
            const cap = Math.min(ctx.maxResults, maxResults);
            const sources = mapParallelResults(raw.results, cap);
            if (sources.length === 0)
                return undefined;
            return [{ name: "Parallel results", sources }];
        },
    };
}
// ---------------------------------------------------------------------------
// Parallel Extract fetch provider (Parallel Web Systems Extract API)
// ---------------------------------------------------------------------------
/** The registered provider id; select it with the web seam `fetchProvider` config. */
export const PARALLEL_EXTRACT_PROVIDER_ID = "parallel-extract";
/** Parallel Extract API endpoint. */
export const PARALLEL_EXTRACT_API_URL = "https://api.parallel.ai/v1/extract";
/** The maximum number of URLs the Parallel Extract API accepts per request. */
export const PARALLEL_EXTRACT_MAX_URLS = 20;
/** Default `extractMode`: request the complete markdown document (`full_content`). */
export const PARALLEL_EXTRACT_MODE_DEFAULT = "full";
/** Default timeout (ms) for a Parallel Extract call — the API is slow (1–20s). */
export const PARALLEL_EXTRACT_TIMEOUT_MS = 60_000;
/**
 * Build the Parallel Extract request body for a batch of URLs, enforcing the
 * API's ≤ {@link PARALLEL_EXTRACT_MAX_URLS} per-request cap. `full` requests
 * the complete markdown document; `snippets` leaves `full_content` off
 * (excerpts only). Throws a `WebError` when the batch is empty or over the cap.
 */
export function buildParallelExtractBody(urls, mode, maxUrls = PARALLEL_EXTRACT_MAX_URLS) {
    if (urls.length === 0) {
        throw new WebError("parallel-extract: at least one URL is required", "WEB_PROVIDER_ERROR");
    }
    if (urls.length > maxUrls) {
        throw new WebError(`parallel-extract: at most ${maxUrls} URLs per Extract request (got ${urls.length})`, "WEB_PROVIDER_ERROR");
    }
    return {
        urls: [...urls],
        advanced_settings: { full_content: mode === "full" },
    };
}
/**
 * Join the non-empty Parallel excerpt strings into one markdown block, or
 * `undefined` when there are no usable excerpts.
 */
export function joinParallelExcerpts(excerpts) {
    if (!Array.isArray(excerpts) || excerpts.length === 0)
        return undefined;
    const parts = excerpts.filter((e) => typeof e === "string" && e.trim().length > 0);
    return parts.length > 0 ? parts.join("\n\n") : undefined;
}
/**
 * Pick the markdown content for one Parallel Extract result item under a mode.
 * `full` prefers the complete `full_content` markdown, falling back to the
 * joined excerpts when the API returned `null` (the source yielded no full
 * document); `snippets` always joins the excerpts. Returns `undefined` when no
 * content is available.
 */
export function extractParallelContent(item, mode) {
    if (mode === "full") {
        if (typeof item.full_content === "string" && item.full_content.length > 0) {
            return item.full_content;
        }
        return joinParallelExcerpts(item.excerpts);
    }
    return joinParallelExcerpts(item.excerpts);
}
/**
 * Locate the result item for a requested URL (trailing-slash-insensitive),
 * falling back to a single-result response (which always corresponds to the
 * requested URL for the fetch-provider case). Returns `undefined` when the URL
 * is not present in `results` (e.g. it was reported in the API's `errors[]`).
 */
export function findParallelExtractResult(response, url) {
    if (!Array.isArray(response.results) || response.results.length === 0)
        return undefined;
    const normalize = (u) => u.replace(/\/+$/, "").trim();
    const target = normalize(url);
    for (const item of response.results) {
        if (typeof item.url === "string" && normalize(item.url) === target)
            return item;
    }
    return response.results.length === 1 ? response.results[0] : undefined;
}
/**
 * Validate a target URL for extraction (http/https only, no credentials,
 * bounded length) — mirrors the other fetch providers' URL hygiene so the
 * provider never forwards a non-web target to the Parallel Extract API.
 */
function validateExtractUrl(input, maxUrlLength = 2048) {
    if (input.length > maxUrlLength) {
        throw new WebError(`URL exceeds the maximum length of ${maxUrlLength}`, "WEB_INVALID_URL");
    }
    let url;
    try {
        url = new URL(input);
    }
    catch (error) {
        throw new WebError(`invalid URL: ${input}`, "WEB_INVALID_URL", { cause: error });
    }
    if (url.protocol !== "http:" && url.protocol !== "https:") {
        throw new WebError(`unsupported URL scheme "${url.protocol}" (only http and https are allowed)`, "WEB_INVALID_URL");
    }
    if (url.username.length > 0 || url.password.length > 0) {
        throw new WebError("credentials in URLs are not allowed", "WEB_BLOCKED_URL");
    }
    return url.toString();
}
/**
 * Compose a timeout onto `signal`: a derived signal that aborts after
 * `timeoutMs` OR on the upstream `signal`, whichever comes first. The returned
 * `dispose()` (idempotent) releases the timer + listener on every path.
 */
function withExtractTimeout(signal, timeoutMs) {
    const controller = new AbortController();
    const source = signal ?? new AbortController().signal;
    const timer = setTimeout(() => controller.abort(new WebError("parallel-extract timed out", "WEB_FETCH_TIMEOUT")), timeoutMs);
    const relay = () => {
        clearTimeout(timer);
        if (controller.signal.aborted)
            return;
        controller.abort(source.reason ?? new Error("aborted"));
    };
    source.addEventListener("abort", relay, { once: true });
    let disposed = false;
    const dispose = () => {
        if (disposed)
            return;
        disposed = true;
        clearTimeout(timer);
        source.removeEventListener("abort", relay);
    };
    return { signal: controller.signal, dispose };
}
/** Translate a throw into the right `WebError` (timeout vs abort vs provider). */
function translateExtractError(error, signal, timeoutMs) {
    if (error instanceof WebError) {
        if (error.code === "WEB_FETCH_TIMEOUT") {
            return new WebError(`parallel-extract timed out after ${timeoutMs} ms`, "WEB_FETCH_TIMEOUT", { cause: error });
        }
        return error;
    }
    if (signal.aborted) {
        return new WebError("web fetch aborted", "WEB_ABORTED", { cause: error });
    }
    const message = error instanceof Error ? error.message : String(error);
    return new WebError(`parallel-extract fetch failed: ${message}`, "WEB_PROVIDER_ERROR", { cause: error });
}
/**
 * The `parallel-extract` fetch provider: retrieves one URL's document as
 * markdown via the Parallel Extract API. Usable only once an API key resolves:
 * the literal `apiKey` wins, else the `apiKeyEnv` environment variable. The
 * provider honours the execution `signal` and its own timeout backstop; any
 * failure throws a `WebError` (the web seam reports it as a structured error
 * rather than returning a misleading result).
 */
export class ParallelExtractProvider {
    id = PARALLEL_EXTRACT_PROVIDER_ID;
    enabled;
    apiKey;
    mode;
    timeoutMs;
    constructor(config) {
        this.enabled = config.enabled;
        this.apiKey = config.apiKey.trim().length > 0
            ? config.apiKey
            : (process.env[config.apiKeyEnv] ?? "");
        this.mode = config.extractMode ?? PARALLEL_EXTRACT_MODE_DEFAULT;
        this.timeoutMs = config.timeoutMs ?? PARALLEL_EXTRACT_TIMEOUT_MS;
    }
    available() {
        return this.enabled && this.apiKey.length > 0;
    }
    async fetch(request, signal) {
        if (signal?.aborted)
            throw new WebError("web fetch aborted", "WEB_ABORTED");
        if (!this.enabled) {
            throw new WebError("parallel-extract: provider is disabled", "WEB_PROVIDER_ERROR");
        }
        if (this.apiKey.length === 0) {
            throw new WebError("parallel-extract: no API key resolved (set the literal apiKey or the apiKeyEnv variable)", "WEB_PROVIDER_ERROR");
        }
        const target = validateExtractUrl(request.url);
        const body = buildParallelExtractBody([target], this.mode);
        const { signal: timeoutSignal, dispose } = withExtractTimeout(signal, this.timeoutMs);
        try {
            const response = await fetch(PARALLEL_EXTRACT_API_URL, {
                method: "POST",
                signal: timeoutSignal,
                headers: {
                    "Content-Type": "application/json",
                    "x-api-key": this.apiKey,
                },
                body: JSON.stringify(body),
            });
            if (!response.ok) {
                throw new WebError(`parallel-extract request failed: HTTP ${response.status}`, "WEB_PROVIDER_ERROR");
            }
            const json = (await response.json());
            if (typeof json !== "object" || json === null || !Array.isArray(json.results)) {
                throw new WebError("parallel-extract: malformed Extract response (missing results array)", "WEB_PROVIDER_ERROR");
            }
            const item = findParallelExtractResult(json, target);
            if (item === undefined) {
                throw new WebError(`parallel-extract: no result for ${target}`, "WEB_PROVIDER_ERROR");
            }
            const content = extractParallelContent(item, this.mode);
            if (content === undefined) {
                throw new WebError(`parallel-extract: no content for ${target}`, "WEB_PROVIDER_ERROR");
            }
            return {
                url: item.url ?? target,
                statusCode: 200,
                body: { kind: "text", content },
                truncated: false,
            };
        }
        catch (error) {
            throw translateExtractError(error, timeoutSignal, this.timeoutMs);
        }
        finally {
            dispose();
        }
    }
}
/**
 * Register the `parallel-extract` fetch provider into the web seam. The seam is
 * resolved OPTIONALLY (`ctx.get('web')`): when absent (minimal compositions)
 * this is a no-op, so the bundle keeps loading without a web service. When
 * present, registration is a reversible effect on this plugin's fiber.
 *
 * Selection is the deployment profile's web-seam config
 * `fetchProvider: 'parallel-extract'` (or `$DSH_WEB_FETCH_PROVIDER`), which is
 * NOT set here — the profile decides.
 */
export function registerParallelExtractProvider(ctx, config) {
    if (!config.enabled)
        return;
    const web = ctx.get("web");
    if (web === undefined)
        return;
    const provider = new ParallelExtractProvider(config);
    const disposer = web.registerFetchProvider(provider);
    ctx.effect(() => disposer, "parallel-extract web-fetch provider");
}
/**
 * Build the RAG search section over a {@link RagEngine}.
 *
 * The engine performs its own index-bootstrapping on query, so a section with
 * an engine is usable immediately; without an engine (RAG disabled or no
 * databases) the section degrades to no blocks. The returned object also
 * carries an `ensureIndex` accessor forwarding to the engine, used by the
 * `rag_index` tool.
 *
 * @param config - the resolved RAG section config (engine + databases).
 * @returns the configured RAG section (with an `ensureIndex` accessor).
 */
export function createRagSection(config) {
    const databases = config.databases;
    return {
        id: "rag",
        enabled: config.enabled,
        async run(query, _ctx) {
            const engine = config.engine;
            if (!config.enabled || engine === undefined || databases.length === 0) {
                return undefined;
            }
            const sections = await engine.query(query, databases);
            const blocks = [];
            for (const section of sections) {
                const sources = section.results.map((r) => ({
                    url: r.path,
                    title: r.title,
                    snippet: r.excerpt,
                    score: r.score,
                    path: r.path,
                }));
                if (sources.length > 0)
                    blocks.push({ name: `RAG — ${section.name}`, sources });
            }
            return blocks.length > 0 ? blocks : undefined;
        },
        async ensureIndex(indexDatabases) {
            if (config.engine === undefined)
                return {};
            return config.engine.ensureIndex(indexDatabases);
        },
    };
}
/**
 * Resolve the `sources` parameter against the enabled sections.
 *
 * `all` (or empty / unknown-only) selects native + every enabled section id.
 * Otherwise the comma tokens `native` plus any enabled section id are
 * selected; unknown tokens are ignored.
 *
 * @param input - the raw `sources` parameter value.
 * @param sections - the enabled sections (from {@link buildSections}).
 * @returns whether to run native and the set of selected section ids.
 */
export function resolveSourcesParameter(input, sections) {
    const trimmed = (input ?? "").trim();
    const enabledIds = sections.map((s) => s.id);
    const all = () => ({ native: true, sections: new Set(enabledIds) });
    if (trimmed.length === 0 || trimmed.toLowerCase() === "all")
        return all();
    let native = false;
    const selected = new Set();
    for (const raw of trimmed.split(",")) {
        const token = raw.trim().toLowerCase();
        if (token === "native")
            native = true;
        else if (enabledIds.includes(token))
            selected.add(token);
    }
    if (!native && selected.size === 0)
        return all();
    return { native, sections: selected };
}
/**
 * Resolve the enabled sections from the `sections` config container, in CONFIG
 * ORDER. Each key is resolved to its section builder; unknown ids are ignored
 * with a warning; a config slice whose `enabled` is false is skipped.
 *
 * @param config - the resolved `sections` config container.
 * @param opts - optional build context: the resolved {@link RagEngine} (used
 *   by the RAG section) and the SearXNG per-call timeout budget.
 * @returns the enabled sections in config order.
 */
export function buildSections(config, opts = {}) {
    const out = [];
    for (const id of Object.keys(config)) {
        if (id === "searxng") {
            const raw = config.searxng;
            const section = createSearxngSection({
                enabled: raw?.enabled ?? true,
                url: raw?.url ?? DEFAULT_SEARXNG_URL,
                timeoutMs: opts.searxngTimeoutMs,
            });
            if (section.enabled)
                out.push(section);
        }
        else if (id === "rag") {
            const raw = config.rag;
            const section = createRagSection({
                enabled: raw?.enabled ?? true,
                engine: opts.ragEngine,
                databases: raw?.databases ?? [],
            });
            if (section.enabled)
                out.push(section);
        }
        else if (id === "parallel") {
            const raw = config.parallel;
            const section = createParallelSection({
                enabled: raw?.enabled ?? true,
                apiKey: raw?.apiKey ?? "",
                apiKeyEnv: raw?.apiKeyEnv ?? "PARALLEL_API_KEY",
                mode: raw?.mode,
                maxResults: raw?.maxResults,
                timeoutMs: opts.parallelTimeoutMs,
            });
            if (section.enabled)
                out.push(section);
        }
        else {
            console.warn(`[dsh-tool-web-enhanced] unknown section id '${id}' ignored`);
        }
    }
    return out;
}
//# sourceMappingURL=modules.js.map