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

import { RagEngine, type RagDatabaseConfig, type RagSection } from "./rag.js";
import { DEFAULT_WEB_TOOL_TIMEOUT_MS } from "@deepseek-ai/dsh-tool-web";

// ---------------------------------------------------------------------------
// Section interface
// ---------------------------------------------------------------------------

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
export const TOPIC_CATEGORIES: Readonly<Record<string, string>> = {
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
export function topicToCategory(topic: string | undefined): string | undefined {
  if (topic === undefined) return undefined;
  const key = topic.trim();
  return Object.prototype.hasOwnProperty.call(TOPIC_CATEGORIES, key)
    ? TOPIC_CATEGORIES[key]
    : undefined;
}

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
export function truncateSnippet(text: string | undefined, max: number): string | undefined {
  if (text === undefined) return undefined;
  const trimmed = text.trim();
  if (trimmed.length === 0) return undefined;
  if (trimmed.length <= max) return trimmed;
  return `${trimmed.slice(0, max - 1)}…`;
}

/**
 * Map one raw SearXNG result item to a {@link SectionSource}.
 *
 * @param item - a SearXNG JSON result item.
 * @returns a source with `url`, `title`, `snippet` (content truncated to
 *   {@link SEARXNG_SNIPPET_MAX_CHARS}); skips a result that lacks a usable URL.
 */
export function mapSearxngSource(item: SearxngResultItem): SectionSource | undefined {
  if (typeof item.url !== "string" || item.url.trim().length === 0) return undefined;
  const source: SectionSource = { url: item.url };
  if (typeof item.title === "string" && item.title.trim().length > 0) {
    source.title = item.title.trim();
  }
  const snippet = truncateSnippet(item.content, SEARXNG_SNIPPET_MAX_CHARS);
  if (snippet !== undefined) source.snippet = snippet;
  return source;
}

/**
 * Map a SearXNG JSON result set to capped, canonical source objects.
 *
 * @param items - the SearXNG `results` array (may be missing/empty).
 * @param maxResults - the deployment source cap applied to the SearXNG section.
 * @returns up to `maxResults` valid sources, in result order.
 */
export function mapSearxngResults(
  items: readonly SearxngResultItem[] | undefined,
  maxResults: number,
): SectionSource[] {
  if (!Array.isArray(items)) return [];
  const out: SectionSource[] = [];
  for (const item of items) {
    if (out.length >= maxResults) break;
    const mapped = mapSearxngSource(item);
    if (mapped !== undefined) out.push(mapped);
  }
  return out;
}

/** The parsed SearXNG JSON API envelope (only the fields we read). */
interface SearxngResponse {
  results?: SearxngResultItem[];
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
export async function fetchSearxng(
  baseUrl: string,
  query: string,
  category: string | undefined,
  signal: AbortSignal | undefined,
  timeoutMs: number,
): Promise<SearxngResultItem[] | undefined> {
  const url = new URL("/search", baseUrl);
  url.searchParams.set("q", query);
  url.searchParams.set("format", "json");
  if (category !== undefined) url.searchParams.set("categories", category);

  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(new DOMException("SearXNG timeout", "TimeoutError")),
    timeoutMs,
  );
  const onExternalAbort = () => controller.abort(signal?.reason);
  if (signal !== undefined) {
    if (signal.aborted) {
      controller.abort(signal.reason);
    } else {
      signal.addEventListener("abort", onExternalAbort, { once: true });
    }
  }

  try {
    const response = await fetch(url.toString(), {
      signal: controller.signal,
      headers: { accept: "application/json" },
    });
    if (!response.ok) return undefined;
    const body = (await response.json()) as SearxngResponse;
    if (typeof body !== "object" || body === null || !Array.isArray(body.results)) {
      return undefined;
    }
    return body.results;
  } catch {
    return undefined;
  } finally {
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
export function formatSearxngOutput(sources: readonly SectionSource[]): string {
  if (sources.length === 0) return "";
  const lines = sources.map((source) => {
    let label: string;
    if (source.title !== undefined && source.title.length > 0) label = source.title;
    else {
      try {
        label = new URL(source.url).hostname;
      } catch {
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
export function createSearxngSection(config: {
  enabled: boolean;
  url: string;
  timeoutMs?: number;
}): SearchSection {
  const timeoutMs = config.timeoutMs ?? DEFAULT_WEB_TOOL_TIMEOUT_MS;
  return {
    id: "searxng",
    enabled: config.enabled,
    async run(query, ctx) {
      const active = config.enabled && config.url.trim().length > 0;
      if (!active) return undefined;
      const category = topicToCategory(ctx.topic);
      const raw = await fetchSearxng(config.url, query, category, ctx.signal, timeoutMs);
      if (raw === undefined) return undefined;
      const sources = mapSearxngResults(raw, ctx.maxResults);
      if (sources.length === 0) return undefined;
      return [{ name: "SearXNG results", sources }];
    },
  };
}

// ---------------------------------------------------------------------------
// RAG section
// ---------------------------------------------------------------------------

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
export function createRagSection(config: RagSectionConfig): SearchSection & {
  ensureIndex(indexDatabases: RagDatabaseConfig[]): Promise<Record<string, number>>;
} {
  const databases = config.databases;
  return {
    id: "rag",
    enabled: config.enabled,
    async run(query, _ctx) {
      const engine = config.engine;
      if (!config.enabled || engine === undefined || databases.length === 0) {
        return undefined;
      }
      const sections: RagSection[] = await engine.query(query, databases);
      const blocks: SectionBlock[] = [];
      for (const section of sections) {
        const sources: SectionSource[] = section.results.map((r) => ({
          url: r.path,
          title: r.title,
          snippet: r.excerpt,
          score: r.score,
          path: r.path,
        }));
        if (sources.length > 0) blocks.push({ name: `RAG — ${section.name}`, sources });
      }
      return blocks.length > 0 ? blocks : undefined;
    },
    async ensureIndex(indexDatabases: RagDatabaseConfig[]): Promise<Record<string, number>> {
      if (config.engine === undefined) return {};
      return config.engine.ensureIndex(indexDatabases);
    },
  };
}

// ---------------------------------------------------------------------------
// Sources-resolution helper
// ---------------------------------------------------------------------------

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
export function resolveSourcesParameter(
  input: string | undefined,
  sections: readonly SearchSection[],
): ResolvedSources {
  const trimmed = (input ?? "").trim();
  const enabledIds: string[] = sections.map((s) => s.id);

  const all = (): ResolvedSources => ({ native: true, sections: new Set(enabledIds) });

  if (trimmed.length === 0 || trimmed.toLowerCase() === "all") return all();

  let native = false;
  const selected = new Set<string>();
  for (const raw of trimmed.split(",")) {
    const token = raw.trim().toLowerCase();
    if (token === "native") native = true;
    else if (enabledIds.includes(token)) selected.add(token);
  }
  if (!native && selected.size === 0) return all();
  return { native, sections: selected };
}

// ---------------------------------------------------------------------------
// buildSections
// ---------------------------------------------------------------------------

/** The `sections` config container (optionally-typed slices per id). */
export interface SectionsConfig {
  searxng?: { enabled?: boolean; url?: string };
  rag?: { enabled?: boolean; databases?: RagDatabaseConfig[] };
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
export function buildSections(
  config: SectionsConfig,
  opts: { ragEngine?: RagEngine | undefined; searxngTimeoutMs?: number } = {},
): SearchSection[] {
  const out: SearchSection[] = [];
  for (const id of Object.keys(config)) {
    if (id === "searxng") {
      const raw = config.searxng;
      const section = createSearxngSection({
        enabled: raw?.enabled ?? true,
        url: raw?.url ?? DEFAULT_SEARXNG_URL,
        timeoutMs: opts.searxngTimeoutMs,
      });
      if (section.enabled) out.push(section);
    } else if (id === "rag") {
      const raw = config.rag;
      const section = createRagSection({
        enabled: raw?.enabled ?? true,
        engine: opts.ragEngine,
        databases: raw?.databases ?? [],
      });
      if (section.enabled) out.push(section);
    } else {
      console.warn(`[dsh-tool-web-enhanced] unknown section id '${id}' ignored`);
    }
  }
  return out;
}
