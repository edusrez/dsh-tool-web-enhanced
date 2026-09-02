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

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

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

/** Options controlling one {@link RagEngine.ensureIndex} pass. */
export interface RagIndexOptions {
  /**
   * Rebuild mode: drop the persisted `chunks` rows and the `files` mtime
   * ledger before re-walking, so every configured file is re-chunked from
   * scratch and the rowid sequence restarts at 1. This is the contract of
   * the `rag_index` tool: running it twice in a row (or after a crash left
   * a partial index) must regenerate a clean store — never collide with
   * stale rows from a previous pass.
   */
  clear?: boolean;
}

/** An embedding provider: maps a batch of texts to their vectors. */
export type Embedder = (texts: string[]) => Promise<number[][]>;

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Maximum chunk text length before a long section is windowed. */
const CHUNK_MAX_CHARS = 2000;

/** Character overlap between adjacent windows of a long section. */
const CHUNK_OVERLAP_CHARS = 200;

/** Minimum trimmed chunk length retained (shorter chunks are dropped). */
const CHUNK_MIN_CHARS = 20;

/** Excerpt length (chars) retained in query results. */
const EXCERPT_MAX_CHARS = 240;

/**
 * Max per-file insert attempts during one index pass: the first attempt plus
 * one bounded "clear-local" retry (the rowid base is re-derived from the vec0
 * shadow PK table / sequence high-water mark before the retry). A file that
 * fails both attempts is SKIPPED with a log — the boot pass continues and the
 * file is retried on the next boot (its mtime is not recorded in the ledger,
 * so it is never silently dropped). One file's UNIQUE failure (the vec0
 * "UNIQUE constraint failed on chunks primary key" on an explicit-rowid
 * insert) must never abort the whole pass.
 */
const MAX_INDEX_FILE_ATTEMPTS = 2;

/**
 * Defensive glob patterns ALWAYS excluded from RAG ingestion, independent of
 * configuration. The walker only ingests `*.md`, so none of these match a
 * file the walker can currently collect — they are a no-op safety net for
 * secret-holding files (`.env`, key drop-ins, credential bundles, systemd
 * units) if the walk ever broadens. Configured `excludePaths` add to this
 * list; they cannot whitelist these paths back in.
 */
export const DEFAULT_EXCLUDE_PATHS: readonly string[] = [
  "**/.env",
  "**/*.conf",
  "**/.credentials.yaml",
];

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
export const DEFAULT_DENY_CONTENT: readonly string[] = [
  // OpenAI/Anthropic-style keys: sk- followed by ≥15 alnum/_/- chars.
  "sk-[A-Za-z0-9_-]{15,}",
  // Secret env assignments with a non-trivial value (a bare mention or a
  // short prose value like "= set in .env" does not match).
  "(?:DEEPSEEK_API_KEY|DEEPINFRA_TOKEN|PARALLEL_API_KEY|OPENCODE_GO_KEY(?:[_\\d]+)?)\\s*=\\s*[A-Za-z0-9_-]{8,}",
];

// ---------------------------------------------------------------------------
// chunkMarkdown
// ---------------------------------------------------------------------------

/** Remove a leading YAML frontmatter block (`---` ... `---` or `...`). */
function stripFrontmatter(text: string): string {
  if (!text.startsWith("---")) return text;
  const end = text.indexOf("\n---", 4);
  if (end === -1) {
    const altEnd = text.indexOf("\n...", 4);
    if (altEnd === -1) return text;
    const after = text.indexOf("\n", altEnd + 1);
    return after === -1 ? "" : text.slice(after + 1);
  }
  const after = text.indexOf("\n", end + 1);
  return after === -1 ? "" : text.slice(after + 1);
}

/** Collapse adjacent blank lines and single-space internal newlines. */
function singleSpace(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/**
 * Split a long chunk's body into ~2000-char windows with ~200-char overlap,
 * breaking at the last `\n\n` (paragraph) boundary before the cut when one
 * exists within the last 200 chars of the window.
 */
function windowChunk(title: string, text: string): RagChunk[] {
  const total = text.length;
  if (total <= CHUNK_MAX_CHARS) return [{ title, text }];

  const windows: RagChunk[] = [];
  let start = 0;
  while (start < total) {
    let end = Math.min(start + CHUNK_MAX_CHARS, total);
    if (end < total) {
      // Prefer a paragraph boundary within the final overlap region.
      const boundary = text.lastIndexOf("\n\n", end);
      if (boundary > start + CHUNK_MAX_CHARS - CHUNK_OVERLAP_CHARS) {
        end = boundary + 1;
      }
    }
    windows.push({ title, text: text.slice(start, end) });
    if (end >= total) break;
    // The next window begins CHUNK_OVERLAP_CHARS before `end`, guaranteeing
    // forward progress (end is always > start because end > start + 0).
    start = Math.max(start + 1, end - CHUNK_OVERLAP_CHARS);
  }

  if (windows.length <= 1) return [{ title, text }];

  return windows.map((w, i) => ({
    title: `${title} (${i + 1}/${windows.length})`,
    text: w.text,
  }));
}

/** Compile regex sources, validating them with a clear error on bad input. */
function compileDenyPatterns(patterns: readonly string[]): RegExp[] {
  return patterns.map((src) => {
    try {
      return new RegExp(src);
    } catch (err) {
      throw new Error(
        `rag: invalid denyContent pattern ${JSON.stringify(src)}: ${(err as Error).message}`,
      );
    }
  });
}

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
export function chunkMarkdown(
  text: string,
  fileTitle: string,
  denyContent?: readonly string[],
): RagChunk[] {
  const chunks = chunkMarkdownImpl(text, fileTitle);
  const denies = compileDenyPatterns([...DEFAULT_DENY_CONTENT, ...(denyContent ?? [])]);
  if (denies.length === 0) return chunks;
  return chunks.filter((c) => !denies.some((re) => re.test(c.text)));
}

/** The heading-aligned splitting itself, with no content filtering. */
function chunkMarkdownImpl(text: string, fileTitle: string): RagChunk[] {
  const body = stripFrontmatter(text);

  const sections: { title: string; content: string }[] = [];
  const headingRe = /^##[ \t]+([^\n]*)$/gm;

  // Find every level-2 heading position, then treat each `[start, nextStart)`
  // span as a section (heading line + body up to the next heading). Text
  // before the first heading becomes a file-titled preamble section.
  const matches: { index: number; title: string; lineLength: number }[] = [];
  let match: RegExpExecArray | null;
  while ((match = headingRe.exec(body)) !== null) {
    matches.push({
      index: match.index,
      title: match[1].trim(),
      lineLength: match[0].length,
    });
  }

  if (matches.length === 0) {
    return toChunks([{ title: fileTitle, content: body }], fileTitle);
  }

  // Preamble before the first heading.
  if (matches[0].index > 0) {
    const pre = body.slice(0, matches[0].index);
    if (pre.trim().length > 0) sections.push({ title: fileTitle, content: pre });
  }

  for (let i = 0; i < matches.length; i++) {
    const start = matches[i].index;
    const end = i + 1 < matches.length ? matches[i + 1].index : body.length;
    sections.push({ title: matches[i].title, content: body.slice(start, end) });
  }

  return toChunks(sections, fileTitle);
}

/** Build final chunks: apply context line, drop short, window long. */
function toChunks(
  sections: { title: string; content: string }[],
  fileTitle: string,
): RagChunk[] {
  const out: RagChunk[] = [];
  for (const section of sections) {
    const headingLine = section.content.startsWith("##") ? section.content.split("\n", 1)[0] : "";
    const bodyText = section.content.startsWith("##")
      ? section.content.slice(headingLine.length).replace(/^\n+/, "")
      : section.content;
    const rawText = headingLine ? `${headingLine}\n${bodyText}` : bodyText;

    // Drop chunks whose raw content (heading + body, before the context line)
    // is shorter than the minimum — the context line is metadata, not content.
    if (rawText.trim().length < CHUNK_MIN_CHARS) continue;

    // Prepend the context line (skipped when the title equals the file title).
    const text = section.title === fileTitle
      ? rawText
      : `Document: ${fileTitle}\n\n${rawText}`;

    const windowed = windowChunk(section.title, text.trim());
    for (const w of windowed) {
      if (w.text.trim().length >= CHUNK_MIN_CHARS) out.push(w);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// parseSources
// ---------------------------------------------------------------------------

/**
 * Parse a comma-separated source selector.
 *
 * @param input - `native,searxng,rag` tokens, or the literal `all`.
 * @returns `'all'`, or a `Set` of the recognised tokens (`native`,
 *   `searxng`, `rag`). Unknown tokens are ignored; an input yielding no
 *   recognised token resolves to `'all'`.
 */
export function parseSources(
  input: string | undefined,
): Set<"native" | "searxng" | "rag"> | "all" {
  const trimmed = (input ?? "").trim();
  if (trimmed.length === 0 || trimmed.toLowerCase() === "all") return "all";

  const known = new Set<"native" | "searxng" | "rag">();
  for (const raw of trimmed.split(",")) {
    const token = raw.trim().toLowerCase();
    if (token === "native" || token === "searxng" || token === "rag") {
      known.add(token);
    }
  }
  return known.size === 0 ? "all" : known;
}

// ---------------------------------------------------------------------------
// l2Normalize
// ---------------------------------------------------------------------------

/** Normalize a vector to unit L2 norm; a zero vector is returned unchanged. */
export function l2Normalize(v: number[]): number[] {
  let sum = 0;
  for (const x of v) sum += x * x;
  const norm = Math.sqrt(sum);
  if (norm === 0) return v;
  return v.map((x) => x / norm);
}

// ---------------------------------------------------------------------------
// RagEngine
// ---------------------------------------------------------------------------

/** Minimal structural surface of `better-sqlite3` used by the engine. */
interface SqliteDatabase {
  exec(sql: string): unknown;
  prepare(sql: string): {
    run(...args: unknown[]): unknown;
    get(...args: unknown[]): unknown;
    all(...args: unknown[]): unknown;
  };
  close(): void;
}

/** The structural shape of the `sqlite-vec` module's `load`. */
interface SqliteVec {
  load(db: unknown): void;
}

/** A lazy-loaded pair of the sqlite store dependencies. */
interface SqliteDeps {
  Database: new (path: string) => SqliteDatabase;
  sqliteVec: SqliteVec;
}

/**
 * An mtime-keyed, file-backed RAG store over Markdown directories.
 *
 * The constructor takes an injected {@link Embedder}; the sqlite stack
 * (`better-sqlite3` + `sqlite-vec`) is loaded lazily on first {@link
 * ensureIndex} / {@link query}, which keeps this module importable when the
 * native deps are absent.
 */
export class RagEngine {
  private readonly storePath: string;
  private readonly embedder: Embedder;
  private readonly logger: (msg: string) => void;
  private readonly filters: RagIngestFilters;

  /**
   * The in-flight index pass, shared by concurrent callers — the boot
   * auto-index, the `rag_index` tool and a query racing the boot-time index
   * (see {@link query}) can all invoke {@link ensureIndex} on one engine.
   * Without serialization, two interleaved passes over one store read the
   * same `MAX(rowid)` base and insert the same explicit rowids, which the
   * vec0 `chunks_rowids` primary key rejects ("UNIQUE constraint failed on
   * chunks primary key"). An incremental caller reuses the in-flight pass; a
   * rebuild (`clear: true`) waits for it and then runs its own clear pass.
   */
  private indexRun: Promise<Record<string, number>> | undefined;

  constructor(opts: {
    storePath: string;
    embedder: Embedder;
    logger?: (msg: string) => void;
    filters?: RagIngestFilters;
  }) {
    this.storePath = opts.storePath;
    this.embedder = opts.embedder;
    this.logger = opts.logger ?? (() => {});
    this.filters = opts.filters ?? {};
    this.indexRun = undefined;
  }

  /** Lazily load the sqlite dependencies (native; imported only on use). */
  private async loadDeps(): Promise<SqliteDeps> {
    // `better-sqlite3` ships no bundled types; the import resolves as `any`.
    // @ts-expect-error -- no bundled types for the optional native dep
    const bsqlite: any = await import("better-sqlite3");
    const Database = bsqlite.default as new (path: string) => SqliteDatabase;
    const sqliteVec = (await import("sqlite-vec")) as unknown as SqliteVec;
    return { Database, sqliteVec };
  }

  /** Embed a batch of texts and L2-normalize each resulting vector. */
  async embed(texts: string[]): Promise<number[][]> {
    const vectors = await this.embedder(texts);
    return vectors.map((v) => l2Normalize(v));
  }

  /**
   * Read-only rowid inventory of the vec0 store, for the H1 diagnostic logged
   * at an insert failure: the attempted rowid, the visible MAX(rowid), the
   * shadow PK table (`chunks_rowids` — the table that owns the UNIQUE the
   * inserts trip) and the `sqlite_sequence` high-water mark, plus a tombstone
   * proxy (rowid inventory vs visible chunk rows). Metadata ONLY: NEVER
   * chunk_text, vectors or any corpus content (fb-14/15 — the corpus holds
   * live keys; the denylist applies to new chunking, not retroactively).
   */
  private vec0FailureState(db: SqliteDatabase, rowid: bigint): string {
    try {
      const maxRow = db
        .prepare("SELECT COALESCE(MAX(rowid), 0) AS m FROM chunks")
        .get() as { m: number | bigint };
      const shadowMax = db
        .prepare("SELECT COALESCE(MAX(rowid), 0) AS m FROM chunks_rowids")
        .get() as { m: number | bigint };
      const seqRow = db
        .prepare(
          "SELECT COALESCE(seq, 0) AS seq FROM sqlite_sequence WHERE name = 'chunks_rowids'",
        )
        .get() as { seq: number | bigint } | undefined;
      const existing = db
        .prepare("SELECT chunk_id FROM chunks_rowids WHERE rowid = ?")
        .get(rowid) as { chunk_id: number } | undefined;
      const shadowCount = db.prepare("SELECT count(*) AS c FROM chunks_rowids").get() as {
        c: number;
      };
      const chunkCount = db.prepare("SELECT count(*) AS c FROM chunks").get() as { c: number };
      const gap = Math.max(0, Number(shadowCount.c) - Number(chunkCount.c));
      return (
        `rowid=${rowid} max_rowid=${maxRow.m} shadow_max=${shadowMax.m} ` +
        `seq_max=${seqRow?.seq ?? 0} existing_chunk_id=${existing?.chunk_id ?? "none"} ` +
        `rowid_gap=${gap}`
      );
    } catch {
      // Shadow reads unsupported (version drift) → diagnostics omitted.
      return "";
    }
  }

  /**
   * Ingest/refresh every configured database, keyed on file mtime.
   *
   * Idempotent: unchanged files (same db, path, mtime) are skipped. Changed
   * or new files are re-chunked, embedded in one call, and (re)inserted.
   * Files removed from disk have their rows deleted. The `chunks` vec0 table
   * is created lazily once the embedding dimension is known, and rebuilt if
   * the dimension changes.
   *
   * Concurrent calls on the same engine are serialized: the boot auto-index,
   * the `rag_index` tool and a query racing the boot-time index share one
   * in-flight pass (an incremental caller reuses it; a `clear` rebuild waits
   * for it and then restarts the store), so two passes can never derive the
   * same explicit rowids.
   *
   * @param databases - the configured database roots.
   * @param opts - pass options; `clear: true` rebuilds from scratch (drop
   *   the persisted chunks and the mtime ledger before re-walking).
   * @returns a record mapping each database name to its stored chunk count.
   */
  async ensureIndex(
    databases: RagDatabaseConfig[],
    opts: RagIndexOptions = {},
  ): Promise<Record<string, number>> {
    const inFlight = this.indexRun;
    if (inFlight !== undefined) {
      if (!opts.clear) return inFlight;
      // A rebuild must start from a settled store: wait for the in-flight
      // pass (completing or failing) before running the clear pass.
      try {
        await inFlight;
      } catch {
        // The in-flight pass failed; the clear rebuild still proceeds (a
        // failed incremental pass must not block a full rebuild).
      }
    }
    const run = this.runEnsureIndex(databases, opts.clear === true);
    this.indexRun = run;
    try {
      return await run;
    } finally {
      if (this.indexRun === run) this.indexRun = undefined;
    }
  }

  /** The actual index pass (serialized by {@link ensureIndex}). */
  private async runEnsureIndex(
    databases: RagDatabaseConfig[],
    clear: boolean,
  ): Promise<Record<string, number>> {
    const fs = await import("node:fs");
    const path = await import("node:path");

    const { Database, sqliteVec } = await this.loadDeps();

    // Determine dimension via a probe embedding.
    const probe = await this.embed(["probe"]);
    const dims = probe[0].length;

    fs.mkdirSync(path.dirname(this.storePath), { recursive: true });
    const db = new Database(this.storePath);
    try {
      sqliteVec.load(db);
      db.exec("CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY, value TEXT)");
      db.exec(
        "CREATE TABLE IF NOT EXISTS files(db_name TEXT, path TEXT, mtime INTEGER, PRIMARY KEY(db_name, path))",
      );

      // Rebuild chunks when the stored dimension differs from the current one.
      const metaGet = db.prepare("SELECT value FROM meta WHERE key = ?");
      const stored = metaGet.get("dims");
      if (stored !== undefined && String((stored as { value: string }).value) !== String(dims)) {
        this.logger(
          `rag: dims changed (${(stored as { value: string }).value} → ${dims}); rebuilding chunks`,
        );
        db.exec("DROP TABLE IF EXISTS chunks");
        db.exec("DELETE FROM files");
      }
      // Rebuild (clear) mode: drop the persisted chunk store and the mtime
      // ledger so the pass re-chunks every configured file from scratch and
      // the rowid sequence restarts at 1. A `rag_index` re-run (after a
      // crash or a partial index) therefore regenerates a clean store instead
      // of continuing from stale rows — the idempotency the rebuild contract
      // requires.
      if (clear) {
        db.exec("DROP TABLE IF EXISTS chunks");
        db.exec("DELETE FROM files");
      }
      // Note: no `id INTEGER PRIMARY KEY` column — vec0 rejects non-integer
      // primary keys, and better-sqlite3 binds JS numbers as REAL. We use the
      // implicit `rowid` and bind it as a BigInt instead.
      db.exec(
        `CREATE VIRTUAL TABLE IF NOT EXISTS chunks USING vec0(` +
          `db_name TEXT, source_path TEXT, chunk_title TEXT, ` +
          `vector FLOAT[${dims}], +chunk_text TEXT)`,
      );

      // The `chunks` table persists between runs, so continue the vec0 `rowid`
      // sequence from its current maximum rather than restarting at 0 each
      // pass (which would reuse live rowids and trip the UNIQUE primary-key
      // constraint). One monotonic counter spans the whole pass. After a
      // dimension-change DROP + rebuild the table is empty, so MAX(rowid) is 0
      // and the sequence correctly restarts at 1. Read on this same connection
      // after the lazy CREATE so the table is guaranteed to exist.
      //
      // The authoritative source of the next free rowid is the vec0 shadow
      // primary-key table `chunks_rowids` (it owns the UNIQUE the inserts must
      // never trip) plus the table's `sqlite_sequence` high-water mark — the
      // AUTOINCREMENT counter never goes backwards, so it exposes rowid slots
      // a past pass allocated that the virtual table's MAX no longer reports
      // (a stale slot like that is the H1 collision vector: an explicit-rowid
      // insert lands on it and vec0 0.1.9 rejects it with "UNIQUE constraint
      // failed on chunks primary key"). Taking max(virtual MAX, shadow MAX,
      // sqlite_sequence) is a no-op on a healthy store (all three agree) and
      // strictly safer when they diverge.
      const maxRowidRow = db
        .prepare("SELECT COALESCE(MAX(rowid), 0) AS max_rowid FROM chunks")
        .get() as { max_rowid: number | bigint };
      let nextRowid = BigInt(maxRowidRow.max_rowid) + 1n;
      try {
        const shadowMaxRow = db
          .prepare("SELECT COALESCE(MAX(rowid), 0) AS max_rowid FROM chunks_rowids")
          .get() as { max_rowid: number | bigint };
        const seqRow = db
          .prepare(
            "SELECT COALESCE(seq, 0) AS seq FROM sqlite_sequence WHERE name = 'chunks_rowids'",
          )
          .get() as { seq: number | bigint } | undefined;
        const floor = BigInt(Math.max(Number(shadowMaxRow.max_rowid), Number(seqRow?.seq ?? 0)));
        if (nextRowid <= floor) nextRowid = floor + 1n;
      } catch {
        // Shadow reads unsupported (version drift) → keep the MAX-based base.
      }

      const counts: Record<string, number> = {};
      const upsertFile = db.prepare(
        "INSERT INTO files(db_name, path, mtime) VALUES (?, ?, ?) " +
          "ON CONFLICT(db_name, path) DO UPDATE SET mtime = excluded.mtime",
      );
      const existingMeta = db.prepare(
        "SELECT path FROM files WHERE db_name = ?",
      );
      // A prepared delete used both to clean re-insert a changed/new file and
      // to drop rows for files removed from disk.
      const deleteChunk = db.prepare(
        "DELETE FROM chunks WHERE db_name = ? AND source_path = ?",
      );

      for (const database of databases) {
        const files = await walkMarkdown(database.path, fs, path, {
          excludePaths: this.filters.excludePaths,
          ignoreDotfiles: this.filters.ignoreDotfiles,
        });
        const filesByPath = new Set(files.map((f) => f.path));

        // Collect existing paths for this db to detect removals.
        const knownRows = existingMeta.all(database.name) as { path: string }[];
        const knownPaths = new Set(knownRows.map((r) => r.path));

        for (const file of files) {
          const stat = fs.statSync(file.path);
          const mtime = Math.floor(stat.mtimeMs);
          const fileRow = db
            .prepare("SELECT mtime FROM files WHERE db_name = ? AND path = ?")
            .get(database.name, file.path) as { mtime: number } | undefined;

          if (fileRow !== undefined && fileRow.mtime === mtime) continue;

          const content = fs.readFileSync(file.path, "utf8");
          const title = path.basename(file.path);
          const chunks = chunkMarkdown(content, title, this.filters.denyContent);
          if (chunks.length > 0) {
            const vectors = await this.embed(chunks.map((c) => c.text));
            const insertChunk = db.prepare(
              "INSERT INTO chunks(rowid, db_name, source_path, chunk_title, vector, chunk_text) " +
                "VALUES (?, ?, ?, ?, ?, ?)",
            );
            // Per-file isolation: one file's insert failure (typically the
            // vec0 "UNIQUE constraint failed on chunks primary key" on an
            // explicit-rowid insert) must NOT abort the whole pass. Each file
            // runs in its own transaction; a failure rolls back ONLY this
            // file, logs the vec0 rowid state (H1 diagnostic) and retries ONCE
            // with the rowid base re-derived from the shadow PK table /
            // sequence high-water mark (skipping any stale slot the virtual
            // MAX no longer reports). A file failing both attempts is skipped
            // with a log and the ledger keeps its old mtime, so the boot pass
            // continues and the file is retried on the next boot — the index
            // ages but the boot is never blocked.
            let inserted = false;
            for (
              let attempt = 1;
              attempt <= MAX_INDEX_FILE_ATTEMPTS && !inserted;
              attempt++
            ) {
              db.exec("BEGIN");
              let lastRowid = 0n;
              try {
                // Clean re-insert: remove this file's prior chunks (bound
                // params, unlike `db.exec`) before inserting the freshly
                // chunked ones. No-op when the file has no prior rows.
                deleteChunk.run(database.name, file.path);
                for (let i = 0; i < chunks.length; i++) {
                  // Track a monotonically increasing rowid as a BigInt — vec0
                  // requires integer primary keys and better-sqlite3 binds JS
                  // numbers as REAL, so a BigInt is mandatory.
                  const rowid = nextRowid++;
                  lastRowid = rowid;
                  insertChunk.run(
                    rowid,
                    database.name,
                    file.path,
                    chunks[i].title,
                    JSON.stringify(vectors[i]),
                    chunks[i].text,
                  );
                }
                db.exec("COMMIT");
                inserted = true;
              } catch (err) {
                db.exec("ROLLBACK");
                const diag = this.vec0FailureState(db, lastRowid);
                const ctx =
                  `${database.name}/${file.path}: ${(err as Error).message}` +
                  (diag ? ` [${diag}]` : "");
                if (attempt >= MAX_INDEX_FILE_ATTEMPTS) {
                  this.logger(
                    `rag: skipping ${ctx} (persistent per-file failure; index ages, boot pass continues)`,
                  );
                } else {
                  // Bounded clear-local retry: step the counter past any rowid
                  // slot the shadow PK / sequence high-water mark knows about,
                  // then re-run this file's delete→re-insert from the rolled
                  // back transaction.
                  try {
                    const shadowRow = db
                      .prepare(
                        "SELECT COALESCE(MAX(rowid), 0) AS max_rowid FROM chunks_rowids",
                      )
                      .get() as { max_rowid: number | bigint };
                    const seqRow = db
                      .prepare(
                        "SELECT COALESCE(seq, 0) AS seq FROM sqlite_sequence WHERE name = 'chunks_rowids'",
                      )
                      .get() as { seq: number | bigint } | undefined;
                    const floor = BigInt(
                      Math.max(Number(shadowRow.max_rowid), Number(seqRow?.seq ?? 0)),
                    );
                    if (nextRowid <= floor) nextRowid = floor + 1n;
                  } catch {
                    // Shadow reads unsupported → retry with the current base.
                  }
                  this.logger(`rag: retrying ${ctx}`);
                }
              }
            }
            if (!inserted) continue;
          }
          upsertFile.run(database.name, file.path, mtime);
        }

        // Remove rows for paths that no longer exist on disk.
        const deleteFile = db.prepare(
          "DELETE FROM files WHERE db_name = ? AND path = ?",
        );
        for (const knownPath of knownPaths) {
          if (!filesByPath.has(knownPath)) {
            deleteChunk.run(database.name, knownPath);
            deleteFile.run(database.name, knownPath);
          }
        }

        const countRow = db
          .prepare("SELECT count(*) AS c FROM chunks WHERE db_name = ?")
          .get(database.name) as { c: number };
        counts[database.name] = countRow.c;
      }

      db.prepare("INSERT INTO meta(key, value) VALUES ('dims', ?) " +
        "ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(String(dims));

      return counts;
    } catch (err) {
      this.logger(`rag: ensureIndex failed: ${(err as Error).message}`);
      throw err;
    } finally {
      db.close();
    }
  }

  /**
   * Run a similarity query against one or more databases.
   *
   * @param queryText - the query string.
   * @param databases - configured databases (sorted by name).
   * @returns one non-empty section per database that has matching chunks.
   */
  async query(queryText: string, databases: RagDatabaseConfig[]): Promise<RagSection[]> {
    const fs = await import("node:fs");
    const { Database, sqliteVec } = await this.loadDeps();

    const [queryVector] = await this.embed([queryText]);

    // Ensure the store is ready before running the KNN loop: a query issued
    // before ensureIndex() has completed (e.g. a web_search racing the
    // boot-time index) must not return an empty RAG section. The store is not
    // ready when the file is missing, when the chunks table has no rows for
    // any of the requested databases, or when the stored dims differ from the
    // current embedder dims — the same checks ensureIndex() performs.
    let storeReady = false;
    if (fs.existsSync(this.storePath)) {
      const probe = new Database(this.storePath);
      try {
        sqliteVec.load(probe);
        const dimsRow = probe
          .prepare("SELECT value FROM meta WHERE key = 'dims'")
          .get() as { value: string } | undefined;
        storeReady = dimsRow !== undefined && Number(dimsRow.value) === queryVector.length;
        if (storeReady) {
          for (const database of databases) {
            const countRow = probe
              .prepare("SELECT count(*) AS c FROM chunks WHERE db_name = ?")
              .get(database.name) as { c: number } | undefined;
            if (countRow === undefined || countRow.c === 0) {
              storeReady = false;
              break;
            }
          }
        }
      } catch {
        // Missing/corrupt tables → rely on ensureIndex() to (re)build.
        storeReady = false;
      } finally {
        probe.close();
      }
    }

    if (!storeReady) {
      // Index (or rebuild) first so the query is deterministic.
      await this.ensureIndex(databases);
    }

    const db = new Database(this.storePath);
    try {
      sqliteVec.load(db);

      const sorted = [...databases].sort((a, b) => a.name.localeCompare(b.name));
      const sections: RagSection[] = [];

      for (const database of sorted) {
        const countRow = db
          .prepare("SELECT count(*) AS c FROM chunks WHERE db_name = ?")
          .get(database.name) as { c: number } | undefined;
        if (countRow === undefined || countRow.c === 0) continue;

        const dimsRow = db
          .prepare("SELECT value FROM meta WHERE key = 'dims'")
          .get() as { value: string } | undefined;
        if (dimsRow !== undefined && Number(dimsRow.value) !== queryVector.length) {
          // Dimension mismatch: skip rather than error against a foreign table.
          continue;
        }

        const rows = db
          .prepare(
            "SELECT rowid, chunk_title, source_path, chunk_text, distance FROM chunks " +
              "WHERE vector MATCH ? AND db_name = ? AND k = ? ORDER BY distance",
          )
          .all(JSON.stringify(queryVector), database.name, database.topK) as {
          rowid: bigint;
          chunk_title: string;
          source_path: string;
          chunk_text: string;
          distance: number;
        }[];

        if (rows.length === 0) continue;

        sections.push({
          name: database.name,
          results: rows.map((r) => ({
            title: r.chunk_title,
            path: r.source_path,
            excerpt: singleSpace(r.chunk_text).slice(0, EXCERPT_MAX_CHARS),
            score: Math.max(0, Math.min(1, 1 - r.distance)),
          })),
        });
      }

      return sections;
    } catch (err) {
      this.logger(`rag: query failed: ${(err as Error).message}`);
      throw err;
    } finally {
      db.close();
    }
  }
}

// ---------------------------------------------------------------------------
// Filesystem walk
// ---------------------------------------------------------------------------

/**
 * Convert a POSIX glob pattern to an anchored RegExp. `*` matches within a
 * path segment, `?` a single segment char, and a `**` crosses segment
 * boundaries (a `**` followed by a slash means zero or more directories; a
 * trailing `**` means any remaining path). Literal regex metacharacters are
 * escaped.
 */
function globToRegExp(pattern: string): RegExp {
  let re = "";
  let i = 0;
  while (i < pattern.length) {
    const c = pattern[i];
    if (c === "*") {
      if (pattern[i + 1] === "*") {
        i += 2;
        if (pattern[i] === "/") {
          // `**/` — zero or more directory segments (matches at the root too).
          re += "(?:[^/]+/)*";
          i += 1;
        } else {
          // trailing `**` — any remaining path.
          re += ".*";
        }
        continue;
      }
      re += "[^/]*";
    } else if (c === "?") {
      re += "[^/]";
    } else {
      re += c.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    }
    i += 1;
  }
  return new RegExp(`^${re}$`);
}

/**
 * Hand-rolled recursive walk collecting `*.md` files (sorted, deterministic).
 *
 * @param root - the database root directory.
 * @param fs - the `node:fs` module (injected for testability).
 * @param path - the `node:path` module (injected for testability).
 * @param opts - optional filters: `excludePaths` globs (POSIX, relative to the
 *   root; merged with {@link DEFAULT_EXCLUDE_PATHS}) and `ignoreDotfiles`
 *   (skip entries whose name starts with `.` — files and directories).
 */
async function walkMarkdown(
  root: string,
  fs: typeof import("node:fs"),
  path: typeof import("node:path"),
  opts: { excludePaths?: readonly string[]; ignoreDotfiles?: boolean } = {},
): Promise<{ path: string }[]> {
  const excludeRe = [...DEFAULT_EXCLUDE_PATHS, ...(opts.excludePaths ?? [])]
    .map((p) => globToRegExp(p));
  const ignoreDotfiles = opts.ignoreDotfiles ?? false;
  const out: { path: string }[] = [];
  const stack: string[] = [root];
  while (stack.length > 0) {
    const dir = stack.pop()!;
    let entries: import("node:fs").Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (ignoreDotfiles && entry.name.startsWith(".")) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) stack.push(full);
      else if (entry.isFile() && entry.name.endsWith(".md")) {
        const rel = path.relative(root, full).replace(/\\/g, "/");
        if (excludeRe.some((re) => re.test(rel))) continue;
        out.push({ path: full });
      }
    }
  }
  out.sort((a, b) => a.path.localeCompare(b.path));
  return out;
}
