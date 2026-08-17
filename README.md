# dsh-tool-web-enhanced

A drop-in enhancement of
[`@deepseek-ai/dsh-tool-web`](https://www.npmjs.com/package/@deepseek-ai/dsh-tool-web)
that **only enhances `web_search`**. `web_fetch` is registered identically to
stock (reused verbatim), so it is byte-for-byte unchanged.

The enhancement adds two things to `web_search`:

1. **An optional `topic` parameter** — a vertical filter mapped to SearXNG
   `categories` (see the table below). Native DeepSeek results are unaffected.
2. **A second results section (`SearXNG results`)** — an optional local
   SearXNG JSON-API lookup appended under the native results.

When SearXNG is absent, disabled, or unreachable, `web_search` degrades
**silently** to exactly the stock behaviour and output shape — no thrown
error, native-only results.

## Install

```bash
npm install dsh-tool-web-enhanced
```

This is a DSH bundle: `package.json` carries `dsh.bundle.patch =
./cordis.patch.yml`, which inserts the plugin row. The profile/preset swaps
`tool-web` → `tool-web-enhanced` so the enhanced tool replaces the stock one.

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

## Config keys

Existing stock keys keep identical names and defaults; SearXNG keys are
additive.

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
`searxngSources` array:

```jsonc
{
  "content": "...",            // optional native answer
  "sources": [ { "url": "...", "title": "...", "snippet": "...", "publishedAt": "..." } ],
  "truncated": false,
  "searxngSources": [ { "url": "...", "title": "...", "snippet": "...", "publishedAt": "..." } ]
}
```

`searxngSources` uses the same source-item shape as `sources`. The rendered
text is the stock `formatSearchOutput(value)` result followed by a
`## SearXNG results` markdown block (same `- [title](url) — snippet` shape),
omitted when there are no SearXNG sources.

## License

MIT
