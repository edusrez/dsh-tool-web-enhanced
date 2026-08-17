/**
 * `dsh-tool-web-enhanced` RAG engine — a local, file-backed retrieval
 * augmentation store over a directory of Markdown documents.
 *
 * The engine ingests `*.md` files, splits them into heading-aligned chunks
 * (with overlap for long sections), embeds each chunk through an injected
 * {@link Embedder} (DeepInfra HTTP or a local transformers.js pipeline — the
 * provider wiring lives elsewhere), and stores the vectors in a
 * `better-sqlite3` + `sqlite-vec` database. Queries embed + normalize the
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
/** An embedding provider: maps a batch of texts to their vectors. */
export type Embedder = (texts: string[]) => Promise<number[][]>;
/**
 * Split Markdown text into heading-aligned chunks.
 *
 * @param text - the raw Markdown content.
 * @param fileTitle - the document title (used for the no-heading case and the
 *   context line).
 * @returns chunks whose titles come from level-2 headings, each prefixed with
 *   a `Document: <fileTitle>` context line (omitted when the chunk title
 *   equals the file title).
 */
export declare function chunkMarkdown(text: string, fileTitle: string): RagChunk[];
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
    constructor(opts: {
        storePath: string;
        embedder: Embedder;
        logger?: (msg: string) => void;
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
