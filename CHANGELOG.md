# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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