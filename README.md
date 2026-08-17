# dsh-tool-web-enhanced

A drop-in enhancement of DeepSeek Harness' web-search tool: adds an optional `topic` vertical filter and a second SearXNG results section to `web_search` — everything else stays byte-for-byte stock.

[![npm](https://img.shields.io/npm/v/dsh-tool-web-enhanced?style=flat-square&logo=npm)](https://www.npmjs.com/package/dsh-tool-web-enhanced)
[![downloads](https://img.shields.io/npm/dw/dsh-tool-web-enhanced?style=flat-square)](https://www.npmjs.com/package/dsh-tool-web-enhanced)
[![license](https://img.shields.io/npm/l/dsh-tool-web-enhanced?style=flat-square)](LICENSE)
[![stars](https://img.shields.io/github/stars/edusrez/dsh-tool-web-enhanced?style=flat-square)](https://github.com/edusrez/dsh-tool-web-enhanced)
[![last commit](https://img.shields.io/github/last-commit/edusrez/dsh-tool-web-enhanced?style=flat-square)](https://github.com/edusrez/dsh-tool-web-enhanced)

## Features

- **Optional `topic` parameter** — `web_search` accepts an optional `topic`
  argument mapped to SearXNG `categories`. Native DeepSeek results are not
  affected.
- **Second results section** — a `SearXNG results` section is appended under
  the native results, using the same source-item shape as the stock `sources`.
- **Silent degradation** — when SearXNG is absent, disabled
  (`searxngEnabled: false`), or unreachable, `web_search` produces exactly
  the stock behaviour and output shape, without throwing.
- **Self-contained drop-in** — installing the bundle registers the enhanced
  tools and disables the stock `tool-web` row automatically (see
  [Install / Quickstart](#install--quickstart)).
- **Optional RAG section** — an optional third RAG section, one
  `## <name> (RAG)` block per configured local database, plus a `sources`
  parameter to select any combination of native/SearXNG/RAG.

## Install / Quickstart

```bash
npm install dsh-tool-web-enhanced
```

This is a DSH bundle: `package.json` carries `dsh.bundle.patch =
./cordis.patch.yml`, which inserts the enhanced plugin row and disables the
stock `tool-web` row in one install. For CLI profiles, installing the package
is the whole swap — no manual profile edit required. For preset-realm Web
surfaces, the preset still disables its own `tool-web` row.

```yaml
# cordis.patch.yml (bundled with this package)
- insert:
    - id: tool-web-enhanced
      name: dsh-tool-web-enhanced
      config:
        search: true
        fetch: true
        searxngUrl: 'http://127.0.0.1:8080'
        searxngEnabled: true

- id: tool-web
  disabled: true
```

## Connecting SearXNG

SearXNG is **optional**. The plugin only talks to it over the local JSON API:

```
GET {searxngUrl}/search?q=<query>&format=json[&categories=<category>]
```

Run any SearXNG instance that exposes `format=json` and point `searxngUrl` at
its base URL. For example, a Docker Compose service at `/opt/searxng`:

```yaml
services:
  searxng:
    image: searxng/searxng:latest
    ports:
      - "8080:8080"
    environment:
      - SEARXNG_BASE_URL=http://127.0.0.1:8080/
    volumes:
      - ./searxng:/etc/searxng
```

then set `searxngUrl: 'http://127.0.0.1:8080'`.

> **Guarantee**: if SearXNG is absent (or `searxngEnabled: false`, or
> `searxngUrl` is empty), `web_search` is **exactly stock** — only the native
> `ctx.web.search` results are produced and rendered.

## `topic` values

`topic` is optional. It maps to the SearXNG `categories` query parameter and
filters only the SearXNG section; the native DeepSeek results are never
filtered. An absent or unrecognised `topic` omits `categories` (SearXNG's
default `general`).

| `topic` value  | SearXNG `categories` |
| -------------- | -------------------- |
| `general`      | `general`            |
| `news`         | `news`               |
| `science`      | `science`            |
| `it`           | `it`                 |
| `files`        | `files`              |
| `social media` | `social media`       |
| `images`       | `images`             |
| `videos`       | `videos`             |
| `map`          | `map`                |
| `music`        | `music`              |

## Configuration reference

Existing stock keys keep identical names and defaults; SearXNG keys are
additive.

> The stock `fetch*` keys are kept ONLY for drop-in config compatibility —
> `web_fetch` is NOT modified by this plugin (it is re-registered verbatim
> from the stock package). Setting them has no enhanced behaviour.

| Key                   | Type    | Default                  | Description |
| --------------------- | ------- | ------------------------ | ----------- |
| `search`              | boolean | `true`                   | Register `web_search`. |
| `fetch`               | boolean | `true`                   | Register `web_fetch` (unchanged). |
| `searchMaxResults`    | number  | `8`                      | Source cap for both native and SearXNG sections. |
| `searchTimeoutMs`     | number  | `30000`                  | Cooperative budget for `web_search` (incl. the SearXNG call). |
| `fetchTimeoutMs`      | number  | `30000`                  | Cooperative budget for `web_fetch`. |
| `fetchMaxOutputChars` | number  | `200000`                 | Output cap for `web_fetch`. |
| `searxngUrl`          | string  | `http://127.0.0.1:8080`  | SearXNG base URL; empty/falsy disables SearXNG. |
| `searxngEnabled`      | boolean | `true`                   | When `false`, skip the SearXNG section entirely. |

> **Note on `searxngEnabled`**: it **defaults to `true`**. With `searxngUrl`
> pointing at `http://127.0.0.1:8080`, a running SearXNG instance is
> expected. If SearXNG is **not** deployed, every `web_search` performs one
> extra (silently-failed) connection attempt to the local JSON API before
> falling back to native-only results — harmless, but avoidable. Set
> `searxngEnabled: false` when you are not using SearXNG to skip that
> attempt entirely.

## Output shape

`web_search` returns the stock canonical shape plus an optional
`searxngSources` array and an optional `rag` array:

```jsonc
{
  "content": "...",            // optional native answer
  "sources": [ { "url": "...", "title": "...", "snippet": "...", "publishedAt": "..." } ],
  "truncated": false,
  "searxngSources": [ { "url": "...", "title": "...", "snippet": "...", "publishedAt": "..." } ],
  "rag": [ { "name": "...", "results": [ { "title": "...", "path": "...", "excerpt": "...", "score": 0.72 } ] } ]
}
```

`searxngSources` uses the same source-item shape as `sources`. The rendered
text is the stock `formatSearchOutput(value)` result followed by a
`## SearXNG results` markdown block (same `- [title](url) — snippet` shape),
omitted when there are no SearXNG sources.

## RAG

The plugin can also augment `web_search` with a **local RAG section**: a
`## <name> (RAG)` block per configured local Markdown database, retrieving the
top-K most similar chunks to the query from a `better-sqlite3` + `sqlite-vec`
store. Chunks are embedded with either DeepInfra (HTTP) or a local
transformers.js ONNX model.

### `sources` parameter

`web_search` accepts an optional `sources` parameter — a comma-separated list
selecting which result sections to include:

| Value      | Section                          |
| ---------- | -------------------------------- |
| `native`   | DeepSeek native results.         |
| `searxng`  | The SearXNG results section.     |
| `rag`      | Local RAG database sections.     |

The default is `all` (every available section). Any combination is allowed,
e.g. `native,rag` or `searxng`.

### `rag_index` tool

When RAG is enabled and at least one database is configured, a `rag_index` tool
is registered. It rebuilds the local RAG index for all configured databases and
returns the number of chunks indexed per database. The index is also built
automatically (async, non-blocking) on plugin startup.

### RAG configuration

| Key                              | Type   | Default                              | Description |
| -------------------------------- | ------ | ------------------------------------ | ----------- |
| `rag.enabled`                    | boolean| `true`                               | Enable the RAG section + `rag_index` tool. |
| `rag.storePath`                  | string | `''` (auto)                          | SQLite store path; empty → `<DSH_HOME>/storages/rag/rag.db`. |
| `rag.embeddings.provider`        | string | `auto`                               | `auto` / `deepinfra` / `local`. `auto` → deepinfra when a key is present, else local. |
| `rag.embeddings.apiKeyEnv`       | string | `DEEPINFRA_TOKEN`                    | Env var name holding the DeepInfra key. |
| `rag.embeddings.apiKey`          | string | `''`                                 | Literal DeepInfra key (wins over `apiKeyEnv`). |
| `rag.embeddings.deepinfraModel`  | string | `BAAI/bge-m3`                        | DeepInfra embedding model. |
| `rag.embeddings.deepinfraBaseURL`| string | `https://api.deepinfra.com/v1/openai`| DeepInfra OpenAI-compatible base URL. |
| `rag.embeddings.localModel`      | string | `Xenova/bge-small-en-v1.5`           | Local transformers.js model. |
| `rag.databases[].name`           | string | —                                    | Database (section) name. |
| `rag.databases[].path`           | string | —                                    | Directory of Markdown files to index. |
| `rag.databases[].topK`           | number | `5`                                  | Results returned per database. |

> **Local embeddings** (the default when no key is configured) download a small
> ONNX model (~34MB) on first use, via the optional
> `@huggingface/transformers` dependency. The **DeepInfra** path uses
> `DEEPINFRA_TOKEN` (or `rag.embeddings.apiKey`). RAG errors degrade silently
> — the section is simply omitted from the output.

## Development

- `npm run build` — compiles `src/` to `lib/` with `tsc` (NodeNext).
- `node --test` — runs the unit tests in `test/` against the built `lib/`.
- Smoke-test in a DSH profile — install the local checkout into an isolated
  development profile, then inspect the composed configuration:

  ```bash
  dsh plugin --profile dev add /path/to/dsh-tool-web-enhanced
  dsh --profile dev --dump-config
  ```

  The dumped tree must show the `tool-web-enhanced` row plus the disabled
  `tool-web` row. Exercise `web_search` end-to-end in that profile afterward.

## License

MIT