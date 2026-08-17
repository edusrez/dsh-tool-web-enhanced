import z from "@deepseek-ai/schemastery";
import type { Context } from "@deepseek-ai/cordis";
import { type SectionBlock, type SectionSource } from "./modules.js";
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
/** Cordis plugin name (distinct from the stock `"tool-web"`). */
export declare const name = "tool-web-enhanced";
/** Services required: the same seam as the stock tool-web plugin. */
export declare const inject: string[];
export { buildSections, createRagSection, createSearxngSection, DEFAULT_SEARXNG_URL, SEARXNG_SNIPPET_MAX_CHARS, TOPIC_CATEGORIES, formatSearxngOutput, mapSearxngResults, mapSearxngSource, resolveSourcesParameter, topicToCategory, truncateSnippet, } from "./modules.js";
export type { SectionBlock, SectionRunContext, SectionSource, SearchSection, } from "./modules.js";
/**
 * Plugin configuration. Extends the stock `dsh-tool-web` keys (which keep
 * identical names and defaults) with a unified `sections` container replacing
 * the former flat top-level search/RAG keys (breaking change).
 */
export declare const Config: z<Schemastery.ObjectS<{
    search: z<boolean, boolean>;
    fetch: z<boolean, boolean>;
    searchMaxResults: z<number, number>;
    fetchTimeoutMs: z<number, number>;
    searchTimeoutMs: z<number, number>;
    fetchMaxOutputChars: z<number, number>;
    sections: z<Schemastery.ObjectS<{
        searxng: z<Schemastery.ObjectS<{
            enabled: z<boolean, boolean>;
            url: z<string, string>;
        }>, Schemastery.ObjectT<{
            enabled: z<boolean, boolean>;
            url: z<string, string>;
        }>>;
        rag: z<Schemastery.ObjectS<{
            enabled: z<boolean, boolean>;
            storePath: z<string, string>;
            embeddings: z<Schemastery.ObjectS<{
                provider: z<"auto" | "remote" | "local", "auto" | "remote" | "local">;
                apiKeyEnv: z<string, string>;
                apiKey: z<string, string>;
                model: z<string, string>;
                baseURL: z<string, string>;
                localModel: z<string, string>;
            }>, Schemastery.ObjectT<{
                provider: z<"auto" | "remote" | "local", "auto" | "remote" | "local">;
                apiKeyEnv: z<string, string>;
                apiKey: z<string, string>;
                model: z<string, string>;
                baseURL: z<string, string>;
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
                provider: z<"auto" | "remote" | "local", "auto" | "remote" | "local">;
                apiKeyEnv: z<string, string>;
                apiKey: z<string, string>;
                model: z<string, string>;
                baseURL: z<string, string>;
                localModel: z<string, string>;
            }>, Schemastery.ObjectT<{
                provider: z<"auto" | "remote" | "local", "auto" | "remote" | "local">;
                apiKeyEnv: z<string, string>;
                apiKey: z<string, string>;
                model: z<string, string>;
                baseURL: z<string, string>;
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
        searxng: z<Schemastery.ObjectS<{
            enabled: z<boolean, boolean>;
            url: z<string, string>;
        }>, Schemastery.ObjectT<{
            enabled: z<boolean, boolean>;
            url: z<string, string>;
        }>>;
        rag: z<Schemastery.ObjectS<{
            enabled: z<boolean, boolean>;
            storePath: z<string, string>;
            embeddings: z<Schemastery.ObjectS<{
                provider: z<"auto" | "remote" | "local", "auto" | "remote" | "local">;
                apiKeyEnv: z<string, string>;
                apiKey: z<string, string>;
                model: z<string, string>;
                baseURL: z<string, string>;
                localModel: z<string, string>;
            }>, Schemastery.ObjectT<{
                provider: z<"auto" | "remote" | "local", "auto" | "remote" | "local">;
                apiKeyEnv: z<string, string>;
                apiKey: z<string, string>;
                model: z<string, string>;
                baseURL: z<string, string>;
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
                provider: z<"auto" | "remote" | "local", "auto" | "remote" | "local">;
                apiKeyEnv: z<string, string>;
                apiKey: z<string, string>;
                model: z<string, string>;
                baseURL: z<string, string>;
                localModel: z<string, string>;
            }>, Schemastery.ObjectT<{
                provider: z<"auto" | "remote" | "local", "auto" | "remote" | "local">;
                apiKeyEnv: z<string, string>;
                apiKey: z<string, string>;
                model: z<string, string>;
                baseURL: z<string, string>;
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
}>, Schemastery.ObjectT<{
    search: z<boolean, boolean>;
    fetch: z<boolean, boolean>;
    searchMaxResults: z<number, number>;
    fetchTimeoutMs: z<number, number>;
    searchTimeoutMs: z<number, number>;
    fetchMaxOutputChars: z<number, number>;
    sections: z<Schemastery.ObjectS<{
        searxng: z<Schemastery.ObjectS<{
            enabled: z<boolean, boolean>;
            url: z<string, string>;
        }>, Schemastery.ObjectT<{
            enabled: z<boolean, boolean>;
            url: z<string, string>;
        }>>;
        rag: z<Schemastery.ObjectS<{
            enabled: z<boolean, boolean>;
            storePath: z<string, string>;
            embeddings: z<Schemastery.ObjectS<{
                provider: z<"auto" | "remote" | "local", "auto" | "remote" | "local">;
                apiKeyEnv: z<string, string>;
                apiKey: z<string, string>;
                model: z<string, string>;
                baseURL: z<string, string>;
                localModel: z<string, string>;
            }>, Schemastery.ObjectT<{
                provider: z<"auto" | "remote" | "local", "auto" | "remote" | "local">;
                apiKeyEnv: z<string, string>;
                apiKey: z<string, string>;
                model: z<string, string>;
                baseURL: z<string, string>;
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
                provider: z<"auto" | "remote" | "local", "auto" | "remote" | "local">;
                apiKeyEnv: z<string, string>;
                apiKey: z<string, string>;
                model: z<string, string>;
                baseURL: z<string, string>;
                localModel: z<string, string>;
            }>, Schemastery.ObjectT<{
                provider: z<"auto" | "remote" | "local", "auto" | "remote" | "local">;
                apiKeyEnv: z<string, string>;
                apiKey: z<string, string>;
                model: z<string, string>;
                baseURL: z<string, string>;
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
        searxng: z<Schemastery.ObjectS<{
            enabled: z<boolean, boolean>;
            url: z<string, string>;
        }>, Schemastery.ObjectT<{
            enabled: z<boolean, boolean>;
            url: z<string, string>;
        }>>;
        rag: z<Schemastery.ObjectS<{
            enabled: z<boolean, boolean>;
            storePath: z<string, string>;
            embeddings: z<Schemastery.ObjectS<{
                provider: z<"auto" | "remote" | "local", "auto" | "remote" | "local">;
                apiKeyEnv: z<string, string>;
                apiKey: z<string, string>;
                model: z<string, string>;
                baseURL: z<string, string>;
                localModel: z<string, string>;
            }>, Schemastery.ObjectT<{
                provider: z<"auto" | "remote" | "local", "auto" | "remote" | "local">;
                apiKeyEnv: z<string, string>;
                apiKey: z<string, string>;
                model: z<string, string>;
                baseURL: z<string, string>;
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
                provider: z<"auto" | "remote" | "local", "auto" | "remote" | "local">;
                apiKeyEnv: z<string, string>;
                apiKey: z<string, string>;
                model: z<string, string>;
                baseURL: z<string, string>;
                localModel: z<string, string>;
            }>, Schemastery.ObjectT<{
                provider: z<"auto" | "remote" | "local", "auto" | "remote" | "local">;
                apiKeyEnv: z<string, string>;
                apiKey: z<string, string>;
                model: z<string, string>;
                baseURL: z<string, string>;
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
}>>;
/** The resolved plugin configuration shape (after schema defaults are applied). */
export interface EnhancedConfig {
    search: boolean;
    fetch: boolean;
    searchMaxResults: number;
    fetchTimeoutMs: number;
    searchTimeoutMs: number;
    fetchMaxOutputChars: number;
    sections: {
        searxng: {
            enabled: boolean;
            url: string;
        };
        rag: {
            enabled: boolean;
            storePath: string;
            embeddings: {
                provider: 'auto' | 'remote' | 'local';
                apiKeyEnv: string;
                apiKey: string;
                model: string;
                baseURL: string;
                localModel: string;
            };
            databases: {
                name: string;
                path: string;
                topK: number;
            }[];
        };
    };
}
/** The resolved RAG config shape produced by {@link resolveRag}. */
export interface ResolvedRag {
    enabled: boolean;
    storePath: string;
    embeddings: {
        provider: 'remote' | 'local';
        apiKeyEnv: string;
        apiKey: string;
        model: string;
        baseURL: string;
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
 * collapse the `auto` provider to a concrete `remote`/`local` choice, and
 * resolve the API key (literal wins, then the environment variable).
 *
 * @param rag - the raw `sections.rag` config from the schema.
 * @returns the resolved RAG configuration.
 */
export declare function resolveRag(rag: EnhancedConfig['sections']['rag']): ResolvedRag;
/**
 * Maximum number of input texts sent to a remote provider per embeddings
 * request. Some remote providers return HTTP 500 on very large single
 * batches, so `createEmbedder` slices the corpus into bounded requests
 * instead of sending everything at once.
 */
export declare const REMOTE_EMBEDDING_BATCH_SIZE = 16;
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
export declare function createEmbedder(embeddings: ResolvedRag['embeddings']): (texts: string[]) => Promise<number[][]>;
/** The canonical `web_search` output value (native + extra source sections). */
export interface WebSearchEnhancedValue {
    content?: string;
    sources: SectionSource[];
    truncated: boolean;
    sections?: SectionBlock[];
}
/**
 * Render a `SectionBlock` as one markdown block. Each source renders as
 * `- **<title-or-hostname>** — <url or path> (score X)` with the snippet on
 * its own indented line when present.
 *
 * @param block - the section block to render.
 * @returns the `## <name>` markdown block, or an empty string when empty.
 */
export declare function formatSectionBlock(block: SectionBlock): string;
/**
 * Render the complete enhanced output: the stock native block (via
 * {@link formatSearchOutput}) followed by each section block in order.
 *
 * @param value - the canonical enhanced output value.
 * @returns the combined model-facing text.
 */
export declare function formatEnhancedSearchOutput(value: WebSearchEnhancedValue): string;
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
