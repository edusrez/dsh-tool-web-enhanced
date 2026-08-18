# dsh-tool-web-enhanced

[English](README.md) | 中文

一个**按板块（section）模块化组织的 `web_search` 工具的直接替代品（drop-in replacement）**：原生搜索结果始终作为第一板块，你可以挂载额外的搜索模块——每个模块贡献自己独立的板块——例如本地 SearXNG 实例和 RAG 数据库（本地 markdown 源）。原生行为保持不变；其他一切均为可选。

[![npm](https://img.shields.io/npm/v/dsh-tool-web-enhanced?style=flat-square&logo=npm)](https://www.npmjs.com/package/dsh-tool-web-enhanced)
[![downloads](https://img.shields.io/npm/dw/dsh-tool-web-enhanced?style=flat-square)](https://www.npmjs.com/package/dsh-tool-web-enhanced)
[![license](https://img.shields.io/npm/l/dsh-tool-web-enhanced?style=flat-square)](LICENSE)
[![stars](https://img.shields.io/github/stars/edusrez/dsh-tool-web-enhanced?style=flat-square)](https://github.com/edusrez/dsh-tool-web-enhanced)
[![last commit](https://img.shields.io/github/last-commit/edusrez/dsh-tool-web-enhanced?style=flat-square)](https://github.com/edusrez/dsh-tool-web-enhanced)

## 这是什么

`dsh-tool-web-enhanced` 是 DeepSeek Harness 自带 `web_search` 工具的直接替代品。当没有配置任何模块时，`web_search` 的行为**完全**与原生一致：原生结果是唯一的板块。开启某个模块后，它会在同一次搜索结果中贡献自己独立的板块：

- **原生** DeepSeek 搜索结果始终作为第一板块，保持不变；
- 你可以**挂载额外的搜索模块**，每个模块渲染为独立的板块——本地 **SearXNG** 实例、**RAG 数据库**（本地 markdown 源）等等；
- 扩展点是一个清晰的模块接口（`SearchSection`）外加一个配置面板（`sections:`），因此新增一种板块类型是一项小而清晰、基于代码层面的步骤（fork 或 PR 本仓库即可）。

一切皆为**可选**：当没有配置任何模块时，`web_search` 与原生完全一致。

## 功能特性

- **按板块模块化的架构** —— 每个搜索源都是一个注册在 `sections:` 之下的 `SearchSection`。原生结果始终排在第一位；每个额外的模块都渲染为独立的板块。
- **内置模块** —— 一个 **SearXNG** 板块（渲染为 `SearXNG results`）和一个基于本地 markdown 数据库的 **RAG** 板块（每个数据库一个 `RAG — <dbName>` 块）。
- **可选的 `topic` 与 `sources` 参数** —— `topic` 将垂直（vertical）提示转发给支持它的模块；`sources` 可选原生 / SearXNG / RAG 的任意组合（`native`、`searxng`、`rag` 或 `all`）。
- **静默降级** —— 缺失、被禁用或不可达的模块会被直接忽略，绝不会报错；结果会降级到剩余板块。
- **自包含的直接替代品** —— 该 bundle 在安装时注册增强后的工具，并自动禁用自带的 `tool-web` 插件行。

## 安装

```bash
npm install dsh-tool-web-enhanced
```

这是一个 DSH bundle：`package.json` 中带有 `dsh.bundle.patch = ./cordis.patch.yml`，它会在一次安装中插入增强后的插件行并禁用自带的 `tool-web` 行。对于 CLI 配置文件（profile），安装这个包就是完整的替换操作——无需手动编辑配置文件。对于 preset-domain 的 Web 界面，preset 仍然会禁用其自身的 `tool-web` 行。

```yaml
# cordis.patch.yml (bundled with this package)
- insert:
    - id: tool-web-enhanced
      name: dsh-tool-web-enhanced
      config:
        search: true
        fetch: true
        sections:
          searxng:
            enabled: true
            url: 'http://127.0.0.1:8080'
          rag:
            enabled: true
            storePath: ''
            embeddings:
              provider: auto
              apiKeyEnv: EMBEDDING_API_KEY
              apiKey: ''
            databases: []

- id: tool-web
  disabled: true
```

安装时会自动禁用自带的 `tool-web` 行，因此这个包就是整个 web 搜索替换的全部内容。

## 配置

增强后的行为全部位于一个统一的 `sections:` 容器之下。键名是中性的参数名。自带的 `search` / `fetch` 键保持原有名称与默认值不变。

| 键                                        | 类型    | 默认值                                   | 说明 |
| ----------------------------------------- | ------- | ---------------------------------------- | ---- |
| `search`                                  | boolean | `true`                                   | 注册 `web_search`。 |
| `fetch`                                   | boolean | `true`                                   | 注册 `web_fetch`（保持不变）。 |
| `sections.searxng.enabled`                | boolean | `true`                                   | 启用 SearXNG 板块。 |
| `sections.searxng.url`                    | string  | `http://127.0.0.1:8080`                  | 本地 SearXNG JSON API 的 Base URL。 |
| `sections.rag.enabled`                    | boolean | `true`                                   | 启用 RAG 板块与 `rag_index` 工具。 |
| `sections.rag.storePath`                  | string  | `''`（自动）                             | 搜索索引的存储路径；为空时使用 data 主目录下的默认位置。 |
| `sections.rag.embeddings.provider`        | string  | `auto`                                   | 嵌入（embedding）选择：`auto` / `local` / `remote`。`auto` → 设置了 key 时用远程，否则用本地。 |
| `sections.rag.embeddings.apiKeyEnv`       | string  | `EMBEDDING_API_KEY`                      | 保存远程 provider key 的环境变量。 |
| `sections.rag.embeddings.apiKey`          | string  | `''`                                     | 远程 provider 的字面 key（优先于 `apiKeyEnv`）。 |
| `sections.rag.embeddings.model`           | string  | `(一个多语言嵌入模型)`                   | 远程嵌入模型。 |
| `sections.rag.embeddings.baseURL`         | string  | `(你的嵌入端点)`                         | 远程嵌入 API 的 Base URL（兼容 embeddings API）。 |
| `sections.rag.embeddings.localModel`      | string  | `(一个小型本地嵌入模型)`                 | 本地嵌入模型（首次使用时下载）。 |
| `sections.rag.databases[].name`           | string  | —                                        | 数据库（板块）名称。 |
| `sections.rag.databases[].path`           | string  | —                                        | 需要建立索引的 markdown 文件目录。 |
| `sections.rag.databases[].topK`           | number  | `5`                                      | 每个数据库返回的结果数量。 |

自带的 `search` / `fetch` 键为保持可直接替换的兼容性而保持不变。

## 使用方法

`web_search` 接受自带的 `query` 外加两个可选参数：

| 参数      | 是否必需 | 说明 |
| --------- | -------- | ---- |
| `query`   | 是       | 搜索查询词。 |
| `topic`   | 否       | 垂直（vertical）提示，转发给支持它的板块（例如 SearXNG 的 categories）：`general`、`news`、`science`、`it`、`files`、`social media`、`images`、`videos`、`map`、`music`。 |
| `sources` | 否       | 以逗号分隔的标记——`native` 加上每一个已启用的板块 id。默认 `all`。示例：`native,searxng` 或 `searxng,rag`。 |

输出的结构包含原生结果外加一个 `sections` 数组——每个返回了结果的模块对应一条记录：

```jsonc
{
  "content": "...",                 // optional native answer
  "sources": [ { "url": "...", "title": "...", "snippet": "..." } ],  // native
  "truncated": false,
  "sections": [
    {
      "name": "SearXNG results",
      "sources": [ { "url": "...", "title": "...", "snippet": "...", "score": 0.9 } ]
    },
    {
      "name": "RAG — my-docs",
      "sources": [ { "url": "...", "title": "...", "path": "...", "score": 0.72 } ]
    }
  ]
}
```

## 连接 SearXNG

SearXNG 板块是**可选的**，且该插件只通过 SearXNG 实例的本地 **JSON** API（`format=json`）与之通信。将 `sections.searxng.url` 指向任何开放 JSON 输出的实例的 Base URL：

```
GET {sections.searxng.url}/search?q=<query>&format=json[&categories=<topic>]
```

最简单的方式是部署一个在本地端口开放 JSON API 的 Docker Compose 服务。没有运行中的实例也没关系：当 SearXNG 板块被禁用、不可达或结果为空时，它会被**静默忽略**。

> **保证**：当一个模块缺失、被禁用或不可达时，`web_search` 绝不会报错——该板块会被直接忽略，结果降级到剩余部分（最低到仅原生，与原生完全一致）。

## RAG 板块

RAG 模块将本地 markdown 数据库索引到本机存储中，并在每次搜索时按数据库检索最相似的内容块——每个已配置的数据库对应一个 `RAG — <dbName>` 板块。

**嵌入（embedding）步骤**用于两个地方：为每个内容块建立索引，以及在每次搜索时对查询词进行嵌入。使用**本地**路径（未配置 key）时，索引与查询数据都保留在本机；只有当你配置了 **remote（远程）** provider 时才会使用它——除非配置了 provider，否则不会发送任何数据。

当 RAG 启用且至少有一个数据库时，会注册一个 **`rag_index`** 工具。它会为所有已配置的数据库重建本地 RAG 索引，并返回每个数据库已建立索引的内容块数量。该索引也会在启动时自动构建（异步、非阻塞）。

## 添加你自己的板块

这个包的核心理念就是让 `web_search` 可以**按板块**模块化。要新增一个搜索源，你只需编写一个小型、自包含的模块——无需对核心工具做任何改动：

1. **定义一个 `SearchSection`** —— 为它提供 `id`（用作 `sources` 标记）、`enabled` 标志，以及一个返回该板块结果块（`SectionBlock[]`）的 `run(query, ctx)` 方法。
2. **在 `cordis.patch.yml` 的 `sections:` 下添加它的配置片段** —— 任何该模块需要的参数。
3. **把它接入 `buildSections`** —— 将新模块与内置模块一起注册，以便在启用时实例化。

仅此而已——大约十五行代码。模块契约位于 `src/modules.ts`（`SearchSection` 接口与 `buildSections` 组合点）。由于模块是一个相互独立的列表，这个包非常适合 fork/PR：新增一种板块类型是一项小而清晰、基于代码层面的加法，可以与原生优先的输出结构以及 `sources` 选择机制组合使用。

## 输出结构

参见上文的[使用方法](#使用方法)：`web_search` 返回标准的自带字段（原生结果的 `content`、`sources` 以及 `truncated`），外加一个 `sections[]` 数组——每个返回了结果的模块对应一条记录，每条记录带一个 `name` 和各自的 `sources[]`。没有结果返回的模块会被完全忽略。

## 开发

- `npm run build` —— 使用 `tsc`（NodeNext）将 `src/` 编译到 `lib/`。
- `node --test` —— 针对构建产物 `lib/` 运行 `test/` 中的单元测试。
- 在 DSH 配置文件中做冒烟测试 —— 将一个隔离的开发配置文件安装到本地 checkout，然后检查组合后的配置：

  ```bash
  dsh plugin --profile dev add /path/to/dsh-tool-web-enhanced
  dsh --profile dev --dump-config
  ```

  转储出的树中必须同时显示 `tool-web-enhanced` 行以及被禁用的 `tool-web` 行。之后在该配置文件中端到端地使用 `web_search`。

## 许可证

MIT
