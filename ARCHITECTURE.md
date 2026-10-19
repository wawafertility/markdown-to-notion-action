# Architecture

This file is optimized for AI agents working on this repository. It describes the stable boundaries, data flow, and constraints that matter when changing the action.

## Goal

`markdown-to-notion-action` is a composite GitHub Action that syncs Markdown files from a caller repository into Notion. The primary v2 mode writes one Notion database item per Markdown file; each database item is also the Notion page that receives the converted Markdown blocks.

## Runtime Shape

- `action.yml` defines a composite action that sets up Node 22, installs project dependencies in the action checkout, and runs `npx tsx src/main.ts`.
- The action runs inside the caller workflow workspace, so file paths and Git operations must resolve against `GITHUB_WORKSPACE`, not the action repository path.
- `src/main.ts` is the orchestration layer. Keep it thin when possible; move reusable behavior into focused modules.
- Notion API calls go through `notionRequest()` in `src/notion-api.ts` so rate-limit retry behavior stays consistent.
- The code must scale to at least 500 Markdown files. Avoid per-file external calls unless the file is new or changed, and prefer paginated bulk reads when APIs support them.

## Sync Modes

### Database Mode

Database mode is the recommended mode and is enabled by `database_id`.

Flow:

1. `src/main.ts` reads inputs and resolves `docs_folder` inside `GITHUB_WORKSPACE`.
2. `loadDatabaseSyncState()` in `src/database-sync-state.ts` resolves the provided Notion database ID to its first data source.
3. Required database properties are created if missing: `Name`, `Repository`, `Docs Folder`, `Path`, `Source Hash`, and `Last Synced At`.
4. Table views are updated to hide `Source Hash`; visibility for all other columns is left unchanged.
5. Database pages are queried once with pagination using a Notion filter scoped by `Repository` and `Docs Folder`, then converted into an in-memory path-to-page map. When several live rows share a path, the oldest `created_time` is canonical and the extras are logged. `archive_duplicate_pages` (default false) archives only those extras.
6. Markdown files are collected from `docs_folder`, excluding private Markdown files whose file name starts with `private_markdown_prefix` (`_` by default) and paths matching `exclude_globs`.
7. Each document is skipped when its `Source Hash` matches the current Markdown body hash and the title still matches.
8. New database items are created before page block upload starts, so later workflow runs can find the item even if the previous run fails mid-upload. Creation re-queries that path first and again immediately after insert; the oldest row wins, and a row this run just created is archived if an older row exists. Page updates are recreated only when the page itself is archived, in trash, or not found. `Can't edit block that is archived` is a child-block failure: the block sync appends a replacement, then the page update is retried once and surfaced if the page is still live.
9. Stale database records in the current `Repository` and `Docs Folder` scope whose `Path` no longer exists in Git are archived in Notion.

Critical fields:

- `Repository`: `GITHUB_REPOSITORY`, used with `Docs Folder` to avoid mixing rows from multiple sync scopes in one database.
- `Docs Folder`: configured docs root relative to repo root, e.g. `docs` or `my-custom/docs`.
- `Path`: full Markdown path relative to repo root, e.g. `docs/api/auth.md`.
- `Source Hash`: SHA-256 of the Markdown body after frontmatter removal. This is the fast skip signal.
- `Last Synced At`: timestamp of the latest successful metadata update for the database item.

### Legacy Parent-Page Mode

Legacy mode is used when `database_id` is not provided and `page_id` or `page_block_id` is provided.

Flow:

1. Markdown files become child pages under `page_id`.
2. Durable sync state is stored in a child page named `_Markdown to Notion Sync Data (do not edit)`.
3. Sync state is compact JSONL split across Notion code blocks to stay below rich-text limits.
4. Optional `page_block_id` adds `link_to_page` blocks after the anchor block.

Do not reintroduce `_notion_links.md`; repository-stored mapping files caused duplicate Notion pages when mapping PRs were not merged quickly.

## Markdown Pipeline

- `src/documents.ts` owns Markdown file discovery, title generation, source hashing, relative link resolution, and conversion entry points.
- `src/markdown-to-notion.ts` wraps `@tryfabric/martian`, sanitizes links, restores standalone Markdown images to real Notion image blocks, and converts `[TOC]` placeholders into Notion `table_of_contents` blocks.
- Title selection is: first Markdown H1, then file name without extension. Folder prefixes are derived from the Markdown path and joined with `title_prefix_separator`.
- Frontmatter may contain legacy `notion_page_id`, but database sync should prefer Notion database state over Markdown metadata.

## Image Uploads

- `src/image-uploads.ts` uploads GitHub-hosted image assets to Notion file uploads before block creation or update.
- Supported upload types are PNG, JPG, JPEG, GIF, SVG, and WEBP.
- Uploads are limited to 20 MB because the implementation uses Notion single-part file uploads.
- GitHub raw URLs are converted to the GitHub Contents API and fetched with `github_token` so private repository images can be read.
- Unsupported image URLs remain external or are skipped with explicit logs.

## Notion API Boundaries

- `src/notion-api.ts` handles ID normalization, URL extraction, child block pagination, and retry/backoff for rate limits.
- `normalizeNotionId()` intentionally prioritizes fragment IDs first, then path IDs, then query IDs. This handles URLs that contain both page and block IDs.
- `src/page-sync.ts` owns page creation/update/archive and the last-edited-time sync decision.
- `src/block-sync.ts` owns incremental block synchronization. It tries to update compatible blocks, replace incompatible blocks, append missing blocks in chunks, and archive stale blocks.

## Performance Constraints

Design for 500 Markdown files:

- Query Notion database pages once per run with a `Repository` + `Docs Folder` filter and pagination, not once per Markdown file.
- Use `Source Hash` as the primary skip signal; unchanged files should not require GitHub per-file commit lookups.
- Use GitHub commit-time checks only when the hash is missing or changed and legacy page update freshness must be determined.
- Keep Notion write concurrency conservative. Notion rate limits are low; `notionRequest()` retries rate-limited calls, and block deletion already uses a small concurrency limit.
- Avoid full block reads for unchanged pages.

## Testing

- Tests use Node's built-in `node:test` runner through `tsx --test`, so no separate test framework dependency is required.
- `npm test` runs focused behavior tests under `test/`.
- `npm run precommit` runs format, typecheck, lint, tests, and Knip.
- Keep tests focused on durable behavior at module boundaries. Avoid brittle tests that assert every generated Notion block detail unless that detail is part of the public behavior.

## Release

- Semantic-release is configured for manual draft GitHub releases.
- Breaking releases use a `BREAKING CHANGE:` footer or `feat!:` commit header.
- The current major release line uses the floating `v3` tag via `.github/update-v3-tag.sh`.
- Release workflow checkout uses bounded history for performance; if the last release tag falls outside that depth, semantic-release can mis-detect the previous release.

## Gotchas

- Notion database IDs and data source IDs are different. The public input is `database_id`; internally the action retrieves the database and uses the first data source for queries and page creation.
- Inline database IDs are easiest to obtain through view settings → Copy link to view. Use the 32-character ID before `?v=`; the `v=` value is the view ID.
- Notion does not hard-delete pages through this action. Deleted or renamed Markdown files result in archived/trash Notion pages.
- `page_block_id` is ignored when `database_id` is provided.
- The action source version in logs comes from `ACTION_SOURCE_REPOSITORY`/`ACTION_SOURCE_REF` injected by `action.yml`; GitHub's default environment variables describe the caller workflow, not necessarily the action repository.
