# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Changed

- **Breaking**: config moved to a unified `sections:` container (`sections.searxng.{enabled,url}` and `sections.rag.*` replace the flat `searxngUrl` / `searxngEnabled` / `rag.*` keys).
- **Breaking**: `web_search` output now uses a `sections[]` array (one entry per module that returned results) instead of the flat `searxngSources` / `rag` fields.
- **Breaking**: `sources` is now derived from enabled modules (`native` + each enabled section id) rather than a fixed native/searxng/rag list.
- SearXNG and RAG are now **built-in modules** of a modular per-section architecture (`SearchSection` interface + `buildSections` composition); adding a new section type is a small, documented code-level step.
- RAG embedding config keys renamed to provider-neutral names (`deepinfraModel`→`model`, `deepinfraBaseURL`→`baseURL`, provider value `deepinfra`→`remote`); `apiKeyEnv` default now `EMBEDDING_API_KEY`.

### Added

- `sources` parameter on `web_search` (native/searxng/rag, default all).
- RAG third section (local embedding model or any configured remote embedding provider, sqlite-vec store, one section per configured database).
- `rag_index` tool.

## [0.1.0-rc.1] - 2026-08-17

### Added

- Optional `topic` parameter on `web_search`, mapped to SearXNG `categories`.
- Second `SearXNG results` section appended under native results.
- Silent native-only degradation when SearXNG is disabled/unavailable.
- Self-contained bundle patch that disables the stock `tool-web` row on install.

### Changed

- `web_fetch` re-registered verbatim from the stock package (unchanged).