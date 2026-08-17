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
// ---------------------------------------------------------------------------
// chunkMarkdown
// ---------------------------------------------------------------------------
/** Remove a leading YAML frontmatter block (`---` ... `---` or `...`). */
function stripFrontmatter(text) {
    if (!text.startsWith("---"))
        return text;
    const end = text.indexOf("\n---", 4);
    if (end === -1) {
        const altEnd = text.indexOf("\n...", 4);
        if (altEnd === -1)
            return text;
        const after = text.indexOf("\n", altEnd + 1);
        return after === -1 ? "" : text.slice(after + 1);
    }
    const after = text.indexOf("\n", end + 1);
    return after === -1 ? "" : text.slice(after + 1);
}
/** Collapse adjacent blank lines and single-space internal newlines. */
function singleSpace(text) {
    return text.replace(/\s+/g, " ").trim();
}
/**
 * Split a long chunk's body into ~2000-char windows with ~200-char overlap,
 * breaking at the last `\n\n` (paragraph) boundary before the cut when one
 * exists within the last 200 chars of the window.
 */
function windowChunk(title, text) {
    const total = text.length;
    if (total <= CHUNK_MAX_CHARS)
        return [{ title, text }];
    const windows = [];
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
        if (end >= total)
            break;
        // The next window begins CHUNK_OVERLAP_CHARS before `end`, guaranteeing
        // forward progress (end is always > start because end > start + 0).
        start = Math.max(start + 1, end - CHUNK_OVERLAP_CHARS);
    }
    if (windows.length <= 1)
        return [{ title, text }];
    return windows.map((w, i) => ({
        title: `${title} (${i + 1}/${windows.length})`,
        text: w.text,
    }));
}
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
export function chunkMarkdown(text, fileTitle) {
    const body = stripFrontmatter(text);
    const sections = [];
    const headingRe = /^##[ \t]+([^\n]*)$/gm;
    // Find every level-2 heading position, then treat each `[start, nextStart)`
    // span as a section (heading line + body up to the next heading). Text
    // before the first heading becomes a file-titled preamble section.
    const matches = [];
    let match;
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
        if (pre.trim().length > 0)
            sections.push({ title: fileTitle, content: pre });
    }
    for (let i = 0; i < matches.length; i++) {
        const start = matches[i].index;
        const end = i + 1 < matches.length ? matches[i + 1].index : body.length;
        sections.push({ title: matches[i].title, content: body.slice(start, end) });
    }
    return toChunks(sections, fileTitle);
}
/** Build final chunks: apply context line, drop short, window long. */
function toChunks(sections, fileTitle) {
    const out = [];
    for (const section of sections) {
        const headingLine = section.content.startsWith("##") ? section.content.split("\n", 1)[0] : "";
        const bodyText = section.content.startsWith("##")
            ? section.content.slice(headingLine.length).replace(/^\n+/, "")
            : section.content;
        const rawText = headingLine ? `${headingLine}\n${bodyText}` : bodyText;
        // Drop chunks whose raw content (heading + body, before the context line)
        // is shorter than the minimum — the context line is metadata, not content.
        if (rawText.trim().length < CHUNK_MIN_CHARS)
            continue;
        // Prepend the context line (skipped when the title equals the file title).
        const text = section.title === fileTitle
            ? rawText
            : `Document: ${fileTitle}\n\n${rawText}`;
        const windowed = windowChunk(section.title, text.trim());
        for (const w of windowed) {
            if (w.text.trim().length >= CHUNK_MIN_CHARS)
                out.push(w);
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
export function parseSources(input) {
    const trimmed = (input ?? "").trim();
    if (trimmed.length === 0 || trimmed.toLowerCase() === "all")
        return "all";
    const known = new Set();
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
export function l2Normalize(v) {
    let sum = 0;
    for (const x of v)
        sum += x * x;
    const norm = Math.sqrt(sum);
    if (norm === 0)
        return v;
    return v.map((x) => x / norm);
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
    storePath;
    embedder;
    logger;
    constructor(opts) {
        this.storePath = opts.storePath;
        this.embedder = opts.embedder;
        this.logger = opts.logger ?? (() => { });
    }
    /** Lazily load the sqlite dependencies (native; imported only on use). */
    async loadDeps() {
        // `better-sqlite3` ships no bundled types; the import resolves as `any`.
        // @ts-expect-error -- no bundled types for the optional native dep
        const bsqlite = await import("better-sqlite3");
        const Database = bsqlite.default;
        const sqliteVec = (await import("sqlite-vec"));
        return { Database, sqliteVec };
    }
    /** Embed a batch of texts and L2-normalize each resulting vector. */
    async embed(texts) {
        const vectors = await this.embedder(texts);
        return vectors.map((v) => l2Normalize(v));
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
     * @returns a record mapping each database name to its stored chunk count.
     */
    async ensureIndex(databases) {
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
            db.exec("CREATE TABLE IF NOT EXISTS files(db_name TEXT, path TEXT, mtime INTEGER, PRIMARY KEY(db_name, path))");
            // Rebuild chunks when the stored dimension differs from the current one.
            const metaGet = db.prepare("SELECT value FROM meta WHERE key = ?");
            const stored = metaGet.get("dims");
            if (stored !== undefined && String(stored.value) !== String(dims)) {
                this.logger(`rag: dims changed (${stored.value} → ${dims}); rebuilding chunks`);
                db.exec("DROP TABLE IF EXISTS chunks");
                db.exec("DELETE FROM files");
            }
            // Note: no `id INTEGER PRIMARY KEY` column — vec0 rejects non-integer
            // primary keys, and better-sqlite3 binds JS numbers as REAL. We use the
            // implicit `rowid` and bind it as a BigInt instead.
            db.exec(`CREATE VIRTUAL TABLE IF NOT EXISTS chunks USING vec0(` +
                `db_name TEXT, source_path TEXT, chunk_title TEXT, ` +
                `vector FLOAT[${dims}], +chunk_text TEXT)`);
            // The `chunks` table persists between runs, so continue the vec0 `rowid`
            // sequence from its current maximum rather than restarting at 0 each
            // pass (which would reuse live rowids and trip the UNIQUE primary-key
            // constraint). One monotonic counter spans the whole pass. After a
            // dimension-change DROP + rebuild the table is empty, so MAX(rowid) is 0
            // and the sequence correctly restarts at 1. Read on this same connection
            // after the lazy CREATE so the table is guaranteed to exist.
            const maxRowidRow = db
                .prepare("SELECT COALESCE(MAX(rowid), 0) AS max_rowid FROM chunks")
                .get();
            let nextRowid = BigInt(maxRowidRow.max_rowid) + 1n;
            const counts = {};
            const upsertFile = db.prepare("INSERT INTO files(db_name, path, mtime) VALUES (?, ?, ?) " +
                "ON CONFLICT(db_name, path) DO UPDATE SET mtime = excluded.mtime");
            const existingMeta = db.prepare("SELECT path FROM files WHERE db_name = ?");
            // A prepared delete used both to clean re-insert a changed/new file and
            // to drop rows for files removed from disk.
            const deleteChunk = db.prepare("DELETE FROM chunks WHERE db_name = ? AND source_path = ?");
            for (const database of databases) {
                const files = await walkMarkdown(database.path, fs, path);
                const filesByPath = new Set(files.map((f) => f.path));
                // Collect existing paths for this db to detect removals.
                const knownRows = existingMeta.all(database.name);
                const knownPaths = new Set(knownRows.map((r) => r.path));
                for (const file of files) {
                    const stat = fs.statSync(file.path);
                    const mtime = Math.floor(stat.mtimeMs);
                    const fileRow = db
                        .prepare("SELECT mtime FROM files WHERE db_name = ? AND path = ?")
                        .get(database.name, file.path);
                    if (fileRow !== undefined && fileRow.mtime === mtime)
                        continue;
                    const content = fs.readFileSync(file.path, "utf8");
                    const title = path.basename(file.path);
                    const chunks = chunkMarkdown(content, title);
                    if (chunks.length > 0) {
                        const vectors = await this.embed(chunks.map((c) => c.text));
                        const insertChunk = db.prepare("INSERT INTO chunks(rowid, db_name, source_path, chunk_title, vector, chunk_text) " +
                            "VALUES (?, ?, ?, ?, ?, ?)");
                        db.exec("BEGIN");
                        try {
                            // Clean re-insert: remove this file's prior chunks (bound params,
                            // unlike `db.exec`) before inserting the freshly chunked ones.
                            deleteChunk.run(database.name, file.path);
                            for (let i = 0; i < chunks.length; i++) {
                                // Track a monotonically increasing rowid as a BigInt — vec0
                                // requires integer primary keys and better-sqlite3 binds JS
                                // numbers as REAL, so a BigInt is mandatory.
                                const rowid = nextRowid++;
                                insertChunk.run(rowid, database.name, file.path, chunks[i].title, JSON.stringify(vectors[i]), chunks[i].text);
                            }
                            db.exec("COMMIT");
                        }
                        catch (err) {
                            db.exec("ROLLBACK");
                            throw err;
                        }
                    }
                    upsertFile.run(database.name, file.path, mtime);
                }
                // Remove rows for paths that no longer exist on disk.
                const deleteFile = db.prepare("DELETE FROM files WHERE db_name = ? AND path = ?");
                for (const knownPath of knownPaths) {
                    if (!filesByPath.has(knownPath)) {
                        deleteChunk.run(database.name, knownPath);
                        deleteFile.run(database.name, knownPath);
                    }
                }
                const countRow = db
                    .prepare("SELECT count(*) AS c FROM chunks WHERE db_name = ?")
                    .get(database.name);
                counts[database.name] = countRow.c;
            }
            db.prepare("INSERT INTO meta(key, value) VALUES ('dims', ?) " +
                "ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(String(dims));
            return counts;
        }
        catch (err) {
            this.logger(`rag: ensureIndex failed: ${err.message}`);
            throw err;
        }
        finally {
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
    async query(queryText, databases) {
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
                    .get();
                storeReady = dimsRow !== undefined && Number(dimsRow.value) === queryVector.length;
                if (storeReady) {
                    for (const database of databases) {
                        const countRow = probe
                            .prepare("SELECT count(*) AS c FROM chunks WHERE db_name = ?")
                            .get(database.name);
                        if (countRow === undefined || countRow.c === 0) {
                            storeReady = false;
                            break;
                        }
                    }
                }
            }
            catch {
                // Missing/corrupt tables → rely on ensureIndex() to (re)build.
                storeReady = false;
            }
            finally {
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
            const sections = [];
            for (const database of sorted) {
                const countRow = db
                    .prepare("SELECT count(*) AS c FROM chunks WHERE db_name = ?")
                    .get(database.name);
                if (countRow === undefined || countRow.c === 0)
                    continue;
                const dimsRow = db
                    .prepare("SELECT value FROM meta WHERE key = 'dims'")
                    .get();
                if (dimsRow !== undefined && Number(dimsRow.value) !== queryVector.length) {
                    // Dimension mismatch: skip rather than error against a foreign table.
                    continue;
                }
                const rows = db
                    .prepare("SELECT rowid, chunk_title, source_path, chunk_text, distance FROM chunks " +
                    "WHERE vector MATCH ? AND db_name = ? AND k = ? ORDER BY distance")
                    .all(JSON.stringify(queryVector), database.name, database.topK);
                if (rows.length === 0)
                    continue;
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
        }
        catch (err) {
            this.logger(`rag: query failed: ${err.message}`);
            throw err;
        }
        finally {
            db.close();
        }
    }
}
// ---------------------------------------------------------------------------
// Filesystem walk
// ---------------------------------------------------------------------------
/** Hand-rolled recursive walk collecting `*.md` files (sorted, deterministic). */
async function walkMarkdown(root, fs, path) {
    const out = [];
    const stack = [root];
    while (stack.length > 0) {
        const dir = stack.pop();
        let entries;
        try {
            entries = fs.readdirSync(dir, { withFileTypes: true });
        }
        catch {
            continue;
        }
        entries.sort((a, b) => a.name.localeCompare(b.name));
        for (const entry of entries) {
            const full = path.join(dir, entry.name);
            if (entry.isDirectory())
                stack.push(full);
            else if (entry.isFile() && entry.name.endsWith(".md"))
                out.push({ path: full });
        }
    }
    out.sort((a, b) => a.path.localeCompare(b.path));
    return out;
}
//# sourceMappingURL=rag.js.map