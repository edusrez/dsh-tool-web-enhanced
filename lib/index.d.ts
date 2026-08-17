import z from "@deepseek-ai/schemastery";
import type { Context } from "@deepseek-ai/cordis";
import { type RagSection } from "./rag.js";
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
/** Cordis plugin name (distinct from the stock `"tool-web"`). */
export declare const name = "tool-web-enhanced";
/** Services required: the same seam as the stock tool-web plugin. */
export declare const inject: string[];
/**
 * Default SearXNG base URL. SearXNG is optional: an empty/falsy `searxngUrl`
 * config value disables the SearXNG section entirely (native-only).
 */
export declare const DEFAULT_SEARXNG_URL = "http://127.0.0.1:8080";
/** Maximum snippet length (chars) retained from a SearXNG result's content. */
export declare const SEARXNG_SNIPPET_MAX_CHARS = 200;
/**
 * The set of `topic` values accepted on `web_search`, each mapped to the
 * SearXNG `categories` value it forwards to the JSON API. `topic` is purely a
 * SearXNG vertical filter: native DeepSeek results are unaffected.
 */
export declare const TOPIC_CATEGORIES: Readonly<Record<string, string>>;
/**
 * Resolve an optional `topic` argument to the SearXNG `categories` value.
 *
 * @param topic - optional vertical from the `web_search` `topic` parameter.
 * @returns the mapped category, or `undefined` when the topic is absent or
 *   unrecognised (the caller then omits `categories`, falling back to
 *   SearXNG's default `general`).
 */
export declare function topicToCategory(topic: string | undefined): string | undefined;
/** The source-item shape shared by `sources` and `searxngSources` in the output. */
export interface SearxngSource {
    url: string;
    title?: string;
    snippet?: string;
    publishedAt?: string;
}
/** One raw SearXNG JSON result item (the fields we consume). */
export interface SearxngResultItem {
    title?: string;
    url?: string;
    content?: string;
    publishedDate?: string | null;
    engine?: string;
    category?: string;
    score?: number;
}
/** Truncate a string to `max` characters, `…`-suffixed when cut. */
export declare function truncateSnippet(text: string | undefined, max: number): string | undefined;
/**
 * Map one raw SearXNG result item to the canonical source shape.
 *
 * @param item - a SearXNG JSON result item.
 * @returns a source with `url`, `title`, `snippet` (content truncated to
 *   {@link SEARXNG_SNIPPET_MAX_CHARS}), and `publishedAt` when present; skips
 *   a result that lacks a usable URL.
 */
export declare function mapSearxngSource(item: SearxngResultItem): SearxngSource | undefined;
/**
 * Map a SearXNG JSON result set to capped, canonical source objects.
 *
 * @param items - the SearXNG `results` array (may be missing/empty).
 * @param maxResults - the deployment source cap applied to the SearXNG section.
 * @returns up to `maxResults` valid sources, in result order.
 */
export declare function mapSearxngResults(items: readonly SearxngResultItem[] | undefined, maxResults: number): SearxngSource[];
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
export declare function fetchSearxng(baseUrl: string, query: string, category: string | undefined, signal: AbortSignal | undefined, timeoutMs: number): Promise<SearxngResultItem[] | undefined>;
/** The canonical `web_search` output value (native + optional SearXNG + RAG sections). */
export interface WebSearchEnhancedValue {
    content?: string;
    sources: SearxngSource[];
    truncated: boolean;
    searxngSources?: SearxngSource[];
    rag?: RagSection[];
}
/**
 * Render the SearXNG section as one markdown block. Reuses the exact
 * `- [title](url) — snippet (publishedAt)` shape of the stock formatter.
 *
 * @param sources - the SearXNG sources (already mapped + capped).
 * @returns a `## SearXNG results` markdown block, or an empty string when
 *   there are no SearXNG sources.
 */
export declare function formatSearxngOutput(sources: readonly SearxngSource[]): string;
/**
 * Render the RAG sections: one `## RAG — <name>` block per section, each
 * result as `- **title** — path (score …)` with the excerpt on its own
 * indented line.
 *
 * @param sections - the RAG sections (from {@link RagEngine.query}).
 * @returns the combined markdown, or an empty string when there are none.
 */
export declare function formatRagOutput(sections: readonly RagSection[] | undefined): string;
/**
 * Render the complete enhanced output: the stock native block (via
 * {@link formatSearchOutput}) followed by the SearXNG block when present.
 *
 * @param value - the canonical enhanced output value.
 * @returns the combined model-facing text.
 */
export declare function formatEnhancedSearchOutput(value: WebSearchEnhancedValue): string;
/**
 * Plugin configuration. Extends the stock `dsh-tool-web` keys (which keep
 * identical names and defaults) with the optional SearXNG-driven keys.
 */
export declare const Config: z<Schemastery.ObjectS<{
    search: z<boolean, boolean>;
    fetch: z<boolean, boolean>;
    searchMaxResults: z<number, number>;
    fetchTimeoutMs: z<number, number>;
    searchTimeoutMs: z<number, number>;
    fetchMaxOutputChars: z<number, number>;
    searxngUrl: z<string, string>;
    searxngEnabled: z<boolean, boolean>;
    rag: z<Schemastery.ObjectS<{
        enabled: z<boolean, boolean>;
        storePath: z<string, string>;
        embeddings: z<Schemastery.ObjectS<{
            provider: z<"auto" | "deepinfra" | "local", "auto" | "deepinfra" | "local">;
            apiKeyEnv: z<string, string>;
            apiKey: z<string, string>;
            deepinfraModel: z<string, string>;
            deepinfraBaseURL: z<string, string>;
            localModel: z<string, string>;
        }>, Schemastery.ObjectT<{
            provider: z<"auto" | "deepinfra" | "local", "auto" | "deepinfra" | "local">;
            apiKeyEnv: z<string, string>;
            apiKey: z<string, string>;
            deepinfraModel: z<string, string>;
            deepinfraBaseURL: z<string, string>;
            localModel: z<string, string>;
        }>>;
        databases: z<({
            name?: string | null | undefined;
            path?: string | null | undefined;
            topK?: number | null | undefined;
        } & import("@deepseek-ai/cosmokit").Dict)[], Schemastery.ObjectT<{
            name: z<string, string>;
            path: z<string, string>;
            topK: z<number, number>;
        }>[]>;
    }>, Schemastery.ObjectT<{
        enabled: z<boolean, boolean>;
        storePath: z<string, string>;
        embeddings: z<Schemastery.ObjectS<{
            provider: z<"auto" | "deepinfra" | "local", "auto" | "deepinfra" | "local">;
            apiKeyEnv: z<string, string>;
            apiKey: z<string, string>;
            deepinfraModel: z<string, string>;
            deepinfraBaseURL: z<string, string>;
            localModel: z<string, string>;
        }>, Schemastery.ObjectT<{
            provider: z<"auto" | "deepinfra" | "local", "auto" | "deepinfra" | "local">;
            apiKeyEnv: z<string, string>;
            apiKey: z<string, string>;
            deepinfraModel: z<string, string>;
            deepinfraBaseURL: z<string, string>;
            localModel: z<string, string>;
        }>>;
        databases: z<({
            name?: string | null | undefined;
            path?: string | null | undefined;
            topK?: number | null | undefined;
        } & import("@deepseek-ai/cosmokit").Dict)[], Schemastery.ObjectT<{
            name: z<string, string>;
            path: z<string, string>;
            topK: z<number, number>;
        }>[]>;
    }>>;
}>, Schemastery.ObjectT<{
    search: z<boolean, boolean>;
    fetch: z<boolean, boolean>;
    searchMaxResults: z<number, number>;
    fetchTimeoutMs: z<number, number>;
    searchTimeoutMs: z<number, number>;
    fetchMaxOutputChars: z<number, number>;
    searxngUrl: z<string, string>;
    searxngEnabled: z<boolean, boolean>;
    rag: z<Schemastery.ObjectS<{
        enabled: z<boolean, boolean>;
        storePath: z<string, string>;
        embeddings: z<Schemastery.ObjectS<{
            provider: z<"auto" | "deepinfra" | "local", "auto" | "deepinfra" | "local">;
            apiKeyEnv: z<string, string>;
            apiKey: z<string, string>;
            deepinfraModel: z<string, string>;
            deepinfraBaseURL: z<string, string>;
            localModel: z<string, string>;
        }>, Schemastery.ObjectT<{
            provider: z<"auto" | "deepinfra" | "local", "auto" | "deepinfra" | "local">;
            apiKeyEnv: z<string, string>;
            apiKey: z<string, string>;
            deepinfraModel: z<string, string>;
            deepinfraBaseURL: z<string, string>;
            localModel: z<string, string>;
        }>>;
        databases: z<({
            name?: string | null | undefined;
            path?: string | null | undefined;
            topK?: number | null | undefined;
        } & import("@deepseek-ai/cosmokit").Dict)[], Schemastery.ObjectT<{
            name: z<string, string>;
            path: z<string, string>;
            topK: z<number, number>;
        }>[]>;
    }>, Schemastery.ObjectT<{
        enabled: z<boolean, boolean>;
        storePath: z<string, string>;
        embeddings: z<Schemastery.ObjectS<{
            provider: z<"auto" | "deepinfra" | "local", "auto" | "deepinfra" | "local">;
            apiKeyEnv: z<string, string>;
            apiKey: z<string, string>;
            deepinfraModel: z<string, string>;
            deepinfraBaseURL: z<string, string>;
            localModel: z<string, string>;
        }>, Schemastery.ObjectT<{
            provider: z<"auto" | "deepinfra" | "local", "auto" | "deepinfra" | "local">;
            apiKeyEnv: z<string, string>;
            apiKey: z<string, string>;
            deepinfraModel: z<string, string>;
            deepinfraBaseURL: z<string, string>;
            localModel: z<string, string>;
        }>>;
        databases: z<({
            name?: string | null | undefined;
            path?: string | null | undefined;
            topK?: number | null | undefined;
        } & import("@deepseek-ai/cosmokit").Dict)[], Schemastery.ObjectT<{
            name: z<string, string>;
            path: z<string, string>;
            topK: z<number, number>;
        }>[]>;
    }>>;
}>>;
/** The resolved plugin configuration shape (after schema defaults are applied). */
export interface EnhancedConfig {
    search: boolean;
    fetch: boolean;
    searchMaxResults: number;
    fetchTimeoutMs: number;
    searchTimeoutMs: number;
    fetchMaxOutputChars: number;
    searxngUrl: string;
    searxngEnabled: boolean;
    rag: {
        enabled: boolean;
        storePath: string;
        embeddings: {
            provider: 'auto' | 'deepinfra' | 'local';
            apiKeyEnv: string;
            apiKey: string;
            deepinfraModel: string;
            deepinfraBaseURL: string;
            localModel: string;
        };
        databases: {
            name: string;
            path: string;
            topK: number;
        }[];
    };
}
/** The resolved RAG config shape produced by {@link resolveRag}. */
export interface ResolvedRag {
    enabled: boolean;
    storePath: string;
    embeddings: {
        provider: 'deepinfra' | 'local';
        apiKeyEnv: string;
        apiKey: string;
        deepinfraModel: string;
        deepinfraBaseURL: string;
        localModel: string;
    };
    databases: {
        name: string;
        path: string;
        topK: number;
    }[];
}
/**
 * Resolve the raw RAG config into concrete values: default the store path,
 * collapse the `auto` provider to a concrete `deepinfra`/`local` choice, and
 * resolve the API key (literal wins, then the environment variable).
 *
 * @param rag - the raw `rag` config from the schema.
 * @returns the resolved RAG configuration.
 */
export declare function resolveRag(rag: EnhancedConfig['rag']): ResolvedRag;
/**
 * Maximum number of input texts sent to DeepInfra per embeddings request.
 * DeepInfra 500s on very large single batches, so `createEmbedder` slices the
 * corpus into bounded requests instead of sending everything at once.
 */
export declare const DEEPINFRA_EMBEDDING_BATCH_SIZE = 16;
/**
 * Split `items` into consecutive, order-preserving batches of at most `size`
 * elements. The last batch is shorter when `items.length` is not a multiple
 * of `size`; an empty input yields no batches.
 *
 * @param items - the items to split (any element type).
 * @param size - the maximum batch size (must be a positive integer).
 * @returns the batches, in input order.
 */
export declare function chunkBatches<T>(items: T[], size: number): T[][];
/**
 * Build an {@link Embedder} for the resolved RAG embeddings config.
 *
 * `deepinfra`: POSTs the inputs in bounded batches (max
 * {@link DEEPINFRA_EMBEDDING_BATCH_SIZE} texts each) to
 * `<deepinfraBaseURL>/embeddings` (OpenAI compatible) and returns
 * `data[].embedding` in input order. `local`: lazily loads a
 * `@huggingface/transformers` feature-extraction pipeline (singleton per
 * model, `q8` quantization) and returns `Array.from(out.data)` for each input
 * text.
 *
 * @param embeddings - the resolved embeddings config (concrete provider + key).
 * @returns an async `(texts) => vectors` embedder.
 */
export declare function createEmbedder(embeddings: ResolvedRag['embeddings']): (texts: string[]) => Promise<number[][]>;
/**
 * Register the enabled web tools. `web_search` is the enhanced variant;
 * `web_fetch` is reused from stock verbatim. All registrations are
 * effect-scoped (the registries clean up on plugin dispose).
 *
 * @param ctx - context whose `tools`, `web`, and `systemPrompt` seam receive
 *   the registrations.
 * @param config - the resolved configuration.
 */
export declare function apply(ctx: Context, config: EnhancedConfig): void;
