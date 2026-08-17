import z from "@deepseek-ai/schemastery";
import { defineTool } from "@deepseek-ai/dsh-tools";
import type { Context } from "@deepseek-ai/cordis";
import {
  applyWebFetchTool,
  formatSearchOutput,
  presentSearchCall,
  presentSearchResult,
  searchMetaFromValue,
  DEFAULT_WEB_TOOL_TIMEOUT_MS,
  DEFAULT_FETCH_MAX_OUTPUT_CHARS,
} from "@deepseek-ai/dsh-tool-web";

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

// ---------------------------------------------------------------------------
// SearXNG result mapping and capping
// ---------------------------------------------------------------------------

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
export function truncateSnippet(text: string | undefined, max: number): string | undefined {
  if (text === undefined) return undefined;
  const trimmed = text.trim();
  if (trimmed.length === 0) return undefined;
  if (trimmed.length <= max) return trimmed;
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
export function mapSearxngSource(item: SearxngResultItem): SearxngSource | undefined {
  if (typeof item.url !== "string" || item.url.trim().length === 0) return undefined;
  const source: SearxngSource = { url: item.url };
  if (typeof item.title === "string" && item.title.trim().length > 0) {
    source.title = item.title.trim();
  }
  const snippet = truncateSnippet(item.content, SEARXNG_SNIPPET_MAX_CHARS);
  if (snippet !== undefined) source.snippet = snippet;
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
export function mapSearxngResults(
  items: readonly SearxngResultItem[] | undefined,
  maxResults: number,
): SearxngSource[] {
  if (!Array.isArray(items)) return [];
  const out: SearxngSource[] = [];
  for (const item of items) {
    if (out.length >= maxResults) break;
    const mapped = mapSearxngSource(item);
    if (mapped !== undefined) out.push(mapped);
  }
  return out;
}

// ---------------------------------------------------------------------------
// SearXNG HTTP fetch (optional, graceful-degrade)
// ---------------------------------------------------------------------------

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
 * @returns the mapped sources, or `undefined` on any failure.
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

// ---------------------------------------------------------------------------
// Two-section render
// ---------------------------------------------------------------------------

/** The canonical `web_search` output value (native + optional SearXNG section). */
export interface WebSearchEnhancedValue {
  content?: string;
  sources: SearxngSource[];
  truncated: boolean;
  searxngSources?: SearxngSource[];
}

/**
 * Render the SearXNG section as one markdown block. Reuses the exact
 * `- [title](url) — snippet (publishedAt)` shape of the stock formatter.
 *
 * @param sources - the SearXNG sources (already mapped + capped).
 * @returns a `## SearXNG results` markdown block, or an empty string when
 *   there are no SearXNG sources.
 */
export function formatSearxngOutput(sources: readonly SearxngSource[]): string {
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
    const meta: string[] = [];
    if (source.snippet !== undefined && source.snippet.length > 0) meta.push(source.snippet);
    if (source.publishedAt !== undefined && source.publishedAt.length > 0) meta.push(`(${source.publishedAt})`);
    const suffix = meta.length > 0 ? ` — ${meta.join(" ")}` : "";
    return `- [${label}](${source.url})${suffix}`;
  });
  return `## SearXNG results\n${lines.join("\n")}`;
}

/**
 * Render the complete enhanced output: the stock native block (via
 * {@link formatSearchOutput}) followed by the SearXNG block when present.
 *
 * @param value - the canonical enhanced output value.
 * @returns the combined model-facing text.
 */
export function formatEnhancedSearchOutput(value: WebSearchEnhancedValue): string {
  const native = formatSearchOutput(value);
  const searxng = value.searxngSources !== undefined ? formatSearxngOutput(value.searxngSources) : "";
  if (searxng.length === 0) return native;
  return `${native}\n\n${searxng}`;
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
});

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
}

/** Configured count and timeout caps must be positive integers. */
function assertPositiveInteger(label: string, value: number): void {
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`tool-web-enhanced: ${label} must be a positive integer`);
  }
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
 */
function applyEnhancedWebSearchTool(
  ctx: Context,
  maxResults: number,
  timeoutMs: number,
  fetchEnabled: boolean,
  searxng: { enabled: boolean; url: string },
): void {
  const searxngActive = searxng.enabled && searxng.url.trim().length > 0;

  ctx.systemPrompt.section({
    name: "tool:web_search",
    order: 110,
    text: fetchEnabled
      ? "Use the web_search tool to discover current information on the web. It returns an optional answer plus a list of source URLs (native results, plus an optional SearXNG section). Follow up with web_fetch when you need the full content of a specific result, and cite the relevant URLs as markdown links."
      : "Use the web_search tool to discover current information on the web. It returns an optional answer plus a list of source URLs (native results, plus an optional SearXNG section). Use the returned source snippets when available, and cite the relevant URLs as markdown links.",
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

      const native = await ctx.web.search(
        { query, maxResults },
        exec.signal,
      );

      const value: WebSearchEnhancedValue = {
        ...(native.content !== undefined ? { content: native.content } : {}),
        sources: native.sources.map((s) => {
          const out: SearxngSource = { url: s.url };
          if (s.title !== undefined) out.title = s.title;
          if (s.snippet !== undefined) out.snippet = s.snippet;
          if (s.publishedAt !== undefined) out.publishedAt = s.publishedAt;
          return out;
        }),
        truncated: native.truncated,
      };

      if (searxngActive) {
        const category = topicToCategory(args.topic);
        const raw = await fetchSearxng(searxng.url, query, category, exec.signal, timeoutMs);
        if (raw !== undefined) {
          const mapped = mapSearxngResults(raw, maxResults);
          if (mapped.length > 0) value.searxngSources = mapped;
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
export function apply(ctx: Context, config: EnhancedConfig): void {
  const resolved = config;
  assertPositiveInteger("searchMaxResults", resolved.searchMaxResults);
  assertPositiveInteger("fetchTimeoutMs", resolved.fetchTimeoutMs);
  assertPositiveInteger("searchTimeoutMs", resolved.searchTimeoutMs);
  assertPositiveInteger("fetchMaxOutputChars", resolved.fetchMaxOutputChars);

  if (resolved.search) {
    applyEnhancedWebSearchTool(
      ctx,
      resolved.searchMaxResults,
      resolved.searchTimeoutMs,
      resolved.fetch,
      { enabled: resolved.searxngEnabled, url: resolved.searxngUrl },
    );
  }
  if (resolved.fetch) {
    // Reuse the stock fetch registration verbatim — web_fetch is unchanged.
    applyWebFetchTool(ctx, resolved.fetchTimeoutMs, resolved.fetchMaxOutputChars);
  }
}
