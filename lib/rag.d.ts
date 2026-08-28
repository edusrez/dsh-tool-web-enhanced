/**
 * `dsh-tool-web-enhanced` RAG engine — a local, file-backed retrieval
 * augmentation store over a directory of Markdown documents.
 *
 * The engine ingests `*.md` files, splits them into heading-aligned chunks
 * (with overlap for long sections), embeds each chunk through an injected
 * {@link Embedder} (a remote embeddings-API call or a local transformers.js
 * pipeline — the provider wiring lives elsewhere), and stores the vectors in
 * a `better-sqlite3` + `sqlite-vec` database. Queries embed + normalize the
 * prompt, then run a vec0 top-K similarity search restricted to a named
 * database, returning title/path/excerpt/score sources.
 *
 * The store is opened and closed per call (no long-lived handle), and the
 * sqlite dependencies are loaded lazily so this module compiles and can be
 * imported even when the optional native deps are not installed.
 *
 * @module dsh-tool-web-enhanced/rag
 */
/** One heading-aligned chunk of a Markdown document. */
export interface RagChunk {
    title: string;
    text: string;
}
/** One retrieved source (a chunk scored against the query). */
export interface RagSource {
    title: string;
    path: string;
    excerpt: string;
    score: number;
}
/** A named section of retrieval results (one per configured database). */
export interface RagSection {
    name: string;
    results: RagSource[];
}
/** Configuration for one RAG database (a directory of Markdown files). */
export interface RagDatabaseConfig {
    name: string;
    path: string;
    topK: number;
}
/** Optional filters applied during RAG ingestion (walk + chunking). */
export interface RagIngestFilters {
    /**
     * Glob patterns (POSIX, relative to each database root) of paths to skip
     * during the walk. Merged with the built-in defensive defaults
     * ({@link DEFAULT_EXCLUDE_PATHS}).
     */
    excludePaths?: readonly string[];
    /**
     * Skip dotfiles and dot-directories (`.env.md`, `.git/`, …) during the walk.
     * Defaults to `false` (current behaviour — dotfiles are walked).
     */
    ignoreDotfiles?: boolean;
    /**
     * Regex sources; any chunk whose text matches one of these patterns is
     * DROPPED before it is embedded. The built-in defaults
     * ({@link DEFAULT_DENY_CONTENT}) always apply; configured patterns add to
     * them.
     */
    denyContent?: readonly string[];
}
/** An embedding provider: maps a batch of texts to their vectors. */
export type Embedder = (texts: string[]) => Promise<number[][]>;
/**
 * Defensive glob patterns ALWAYS excluded from RAG ingestion, independent of
 * configuration. The walker only ingests `*.md`, so none of these match a
 * file the walker can currently collect — they are a no-op safety net for
 * secret-holding files (`.env`, key drop-ins, credential bundles, systemd
 * units) if the walk ever broadens. Configured `excludePaths` add to this
 * list; they cannot whitelist these paths back in.
 */
export declare const DEFAULT_EXCLUDE_PATHS: readonly string[];
/**
 * Default content-denylist regexes, applied to every produced chunk before it
 * is embedded: a chunk whose text matches any pattern is discarded. The
 * patterns target high-entropy API keys (`sk-…`) and secret environment
 * ASSIGNMENTS (`DEEPSEEK_API_KEY=…`, `OPENCODE_GO_KEY_n=…`,
 * `DEEPINFRA_TOKEN=…`, `PARALLEL_API_KEY=…`), while prose that merely NAMES
 * these variables (e.g. "the DEEPINFRA_TOKEN config") survives — preserving
 * legitimate technical discussion in the corpus. Configured `denyContent`
 * patterns add to this list; they cannot re-admit a matched chunk.
 */
export declare const DEFAULT_DENY_CONTENT: readonly string[];
/**
 * Split Markdown text into heading-aligned chunks.
 *
 * @param text - the raw Markdown content.
 * @param fileTitle - the document title (used for the no-heading case and the
 *   context line).
 * @param denyContent - optional regex sources; a chunk whose text matches any
 *   pattern is dropped. The built-in {@link DEFAULT_DENY_CONTENT} is ALWAYS
 *   applied on top of the given patterns, so secret-bearing chunks never
 *   reach the embedder.
 * @returns chunks whose titles come from level-2 headings, each prefixed with
 *   a `Document: <fileTitle>` context line (omitted when the chunk title
 *   equals the file title).
 */
export declare function chunkMarkdown(text: string, fileTitle: string, denyContent?: readonly string[]): RagChunk[];
/**
 * Parse a comma-separated source selector.
 *
 * @param input - `native,searxng,rag` tokens, or the literal `all`.
 * @returns `'all'`, or a `Set` of the recognised tokens (`native`,
 *   `searxng`, `rag`). Unknown tokens are ignored; an input yielding no
 *   recognised token resolves to `'all'`.
 */
export declare function parseSources(input: string | undefined): Set<"native" | "searxng" | "rag"> | "all";
/** Normalize a vector to unit L2 norm; a zero vector is returned unchanged. */
export declare function l2Normalize(v: number[]): number[];
/**
 * An mtime-keyed, file-backed RAG store over Markdown directories.
 *
 * The constructor takes an injected {@link Embedder}; the sqlite stack
 * (`better-sqlite3` + `sqlite-vec`) is loaded lazily on first {@link
 * ensureIndex} / {@link query}, which keeps this module importable when the
 * native deps are absent.
 */
export declare class RagEngine {
    private readonly storePath;
    private readonly embedder;
    private readonly logger;
    private readonly filters;
    constructor(opts: {
        storePath: string;
        embedder: Embedder;
        logger?: (msg: string) => void;
        filters?: RagIngestFilters;
    });
    /** Lazily load the sqlite dependencies (native; imported only on use). */
    private loadDeps;
    /** Embed a batch of texts and L2-normalize each resulting vector. */
    embed(texts: string[]): Promise<number[][]>;
    /**
     * Ingest/refresh every configured database, keyed on file mtime.
     *
     * Idempotent: unchanged files (same db, path, mtime) are skipped. Changed
     * or new files are re-chunked, embedded in one call, and (re)inserted.
     * Files removed from disk have their rows deleted. The `chunks` vec0 table
     * is created lazily once the embedding dimension is known, and rebuilt if
     * the dimension changes.
     *
     * @returns a record mapping each database name to its stored chunk count.
     */
    ensureIndex(databases: RagDatabaseConfig[]): Promise<Record<string, number>>;
    /**
     * Run a similarity query against one or more databases.
     *
     * @param queryText - the query string.
     * @param databases - configured databases (sorted by name).
     * @returns one non-empty section per database that has matching chunks.
     */
    query(queryText: string, databases: RagDatabaseConfig[]): Promise<RagSection[]>;
}
