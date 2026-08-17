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
import { RagEngine, type RagDatabaseConfig } from "./rag.js";
/** One retrieved source item returned by a section. */
export interface SectionSource {
    url: string;
    title?: string;
    snippet?: string;
    score?: number;
    /** For file-backed sources (RAG), the on-disk path; falls back to `url`. */
    path?: string;
}
/** One named block of sources produced by a section. */
export interface SectionBlock {
    name: string;
    sources: SectionSource[];
}
/** Per-section execution context passed to {@link SearchSection.run}. */
export interface SectionRunContext {
    maxResults: number;
    topic?: string;
    /** The section ids selected by the `sources` parameter (resolved). */
    sources: Set<string>;
    signal?: AbortSignal;
}
/** A pluggable source section for `web_search`. */
export interface SearchSection {
    /** Used in the `sources` parameter and the `sections` config key. */
    id: string;
    enabled: boolean;
    /**
     * Produce the section's source blocks for a query, or `undefined` to omit
     * the section entirely (empty result / unavailable backend).
     */
    run(query: string, ctx: SectionRunContext): Promise<SectionBlock[] | undefined>;
}
/**
 * Default SearXNG base URL. SearXNG is optional: an empty/falsy `url` config
 * value disables the SearXNG section entirely (native-only).
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
/** The raw SearXNG result-item shape (the fields we consume). */
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
 * Map one raw SearXNG result item to a {@link SectionSource}.
 *
 * @param item - a SearXNG JSON result item.
 * @returns a source with `url`, `title`, `snippet` (content truncated to
 *   {@link SEARXNG_SNIPPET_MAX_CHARS}); skips a result that lacks a usable URL.
 */
export declare function mapSearxngSource(item: SearxngResultItem): SectionSource | undefined;
/**
 * Map a SearXNG JSON result set to capped, canonical source objects.
 *
 * @param items - the SearXNG `results` array (may be missing/empty).
 * @param maxResults - the deployment source cap applied to the SearXNG section.
 * @returns up to `maxResults` valid sources, in result order.
 */
export declare function mapSearxngResults(items: readonly SearxngResultItem[] | undefined, maxResults: number): SectionSource[];
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
export declare function fetchSearxng(baseUrl: string, query: string, category: string | undefined, signal: AbortSignal | undefined, timeoutMs: number): Promise<SearxngResultItem[] | undefined>;
/**
 * Render a SearXNG sources block (used by tests / tooling).
 *
 * @param sources - the mapped SearXNG sources.
 * @returns a `## SearXNG results` markdown block, or an empty string when
 *   there are no sources.
 */
export declare function formatSearxngOutput(sources: readonly SectionSource[]): string;
/**
 * Build the SearXNG search section.
 *
 * @param config - the SearXNG config slice: `{ enabled, url }` (plus an
 *   optional internal `timeoutMs` for the per-call bound).
 * @returns the configured SearXNG section.
 */
export declare function createSearxngSection(config: {
    enabled: boolean;
    url: string;
    timeoutMs?: number;
}): SearchSection;
/**
 * Config slice available to the RAG section builder.
 */
export interface RagSectionConfig {
    enabled: boolean;
    engine: RagEngine | undefined;
    databases: RagDatabaseConfig[];
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
export declare function createRagSection(config: RagSectionConfig): SearchSection & {
    ensureIndex(indexDatabases: RagDatabaseConfig[]): Promise<Record<string, number>>;
};
/** The resolved `sources` parameter: whether native runs plus selected section ids. */
export interface ResolvedSources {
    native: boolean;
    sections: Set<string>;
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
export declare function resolveSourcesParameter(input: string | undefined, sections: readonly SearchSection[]): ResolvedSources;
/** The `sections` config container (optionally-typed slices per id). */
export interface SectionsConfig {
    searxng?: {
        enabled?: boolean;
        url?: string;
    };
    rag?: {
        enabled?: boolean;
        databases?: RagDatabaseConfig[];
    };
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
export declare function buildSections(config: SectionsConfig, opts?: {
    ragEngine?: RagEngine | undefined;
    searxngTimeoutMs?: number;
}): SearchSection[];
