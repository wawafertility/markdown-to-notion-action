import path from "node:path";

import * as core from "@actions/core";
import { Client } from "@notionhq/client";

import { appendBlocksSafe, appendPageLinksAfterAnchor } from "./block-sync.js";
import { buildDatabasePageProperties, loadDatabaseSyncState } from "./database-sync-state.js";
import {
  buildBlocksForDocument,
  buildNotionPageTitle,
  collectMarkdownFiles,
  ensureDirectoryExists,
  loadMarkdownDocuments,
  normalizeDocumentPath,
} from "./documents.js";
import { createLogContext, describeError } from "./logging.js";
import { appendSyncStateRecord, loadSyncState, writeSyncState } from "./notion-sync-state.js";
import {
  isNotionArchivedError,
  isNotionNotFoundError,
  normalizeNotionId,
  notionPageUrl,
} from "./notion-api.js";
import {
  archivePageIfPresent,
  createDataSourcePage,
  createPage,
  getSyncDecision,
  resolveParentPageId,
  updateDataSourcePageContent,
  updateDataSourcePageProperties,
  updatePageContent,
} from "./page-sync.js";
import { resolveInsideRoot } from "./path-utils.js";
import {
  normalizePrivateMarkdownPrefix,
  normalizeTitlePrefixSeparator,
  readInput,
} from "./action-inputs.js";
import type { DatabaseSyncState } from "./database-sync-state.js";
import type { MarkdownDocument, SyncStateEntry, SyncedPage } from "./sync-types.js";

type RuntimeContext = {
  docsFolder: string;
  docsFolderPath: string;
  excludeGlobs: string[];
  githubToken: string | null;
  notion: Client;
  privateMarkdownPrefix: string | null;
  titlePrefixSeparator: string;
  workspaceRoot: string;
};

async function run(): Promise<void> {
  try {
    const actionReference =
      process.env.ACTION_SOURCE_REF || process.env.GITHUB_ACTION_REF || "unknown";
    const actionRepo =
      process.env.ACTION_SOURCE_REPOSITORY || process.env.GITHUB_ACTION_REPOSITORY || "unknown";
    core.info(`Action source: ${actionRepo}@${actionReference}`);

    const notionToken = readInput("notion_token", ["NOTION_TOKEN"]);
    const docsFolder = readInput("docs_folder", ["DOCS_FOLDER"]);
    if (!notionToken || !docsFolder) {
      throw new Error("Missing required inputs. Check notion_token and docs_folder.");
    }

    const pageBlockInput = readInput("page_block_id", ["PAGE_BLOCK_ID"]);
    const pageInput = readInput("page_id", ["PAGE_ID"]);
    const databaseInput = readInput("database_id", ["DATABASE_ID"]);
    const privateMarkdownPrefixInput = readInput("private_markdown_prefix", [
      "PRIVATE_MARKDOWN_PREFIX",
    ]);
    const excludeGlobs = readInput("exclude_globs", ["EXCLUDE_GLOBS"])
      .split(/\r?\n/)
      .filter(Boolean);
    const titlePrefixSeparatorInput = readInput("title_prefix_separator", [
      "TITLE_PREFIX_SEPARATOR",
    ]);
    const githubToken = readInput("github_token", ["GITHUB_TOKEN"]);

    core.setSecret(notionToken);
    if (githubToken) {
      core.setSecret(githubToken);
    }

    const notion = new Client({ auth: notionToken });
    const workspaceRoot = process.env.GITHUB_WORKSPACE || process.cwd();
    const docsFolderPath = resolveInsideRoot(workspaceRoot, docsFolder, "docs_folder");
    const docsFolderForSync =
      normalizeDocumentPath(path.relative(workspaceRoot, docsFolderPath)).replace(/\/+$/, "") ||
      ".";
    await ensureDirectoryExists(docsFolderPath);

    const privateMarkdownPrefix = normalizePrivateMarkdownPrefix(privateMarkdownPrefixInput);
    if (privateMarkdownPrefix) {
      core.info(`Skipping markdown files whose file name starts with '${privateMarkdownPrefix}'.`);
    } else {
      core.info("Private markdown file prefix disabled; all markdown files can be synced.");
    }
    if (excludeGlobs.length > 0) {
      core.info(`Excluding markdown paths matching: ${excludeGlobs.join(", ")}`);
    }

    const context: RuntimeContext = {
      docsFolder: docsFolderForSync,
      docsFolderPath,
      excludeGlobs,
      githubToken,
      notion,
      privateMarkdownPrefix,
      titlePrefixSeparator: normalizeTitlePrefixSeparator(titlePrefixSeparatorInput),
      workspaceRoot,
    };

    if (databaseInput) {
      await syncDatabaseMode(context, databaseInput);
      return;
    }

    await syncPageMode(context, pageInput, pageBlockInput);
  } catch (error) {
    core.setFailed(describeError(error));
  }
}

async function syncDatabaseMode(context: RuntimeContext, databaseInput: string): Promise<void> {
  const repo = process.env.GITHUB_REPOSITORY || "local";
  const databaseState = await loadDatabaseSyncState(
    context.notion,
    databaseInput,
    repo,
    context.docsFolder,
    createLogContext("database"),
  );
  const documents = await loadDocuments(context, new Map());
  const knownPageUrls = buildKnownPageUrlsFromSyncEntries(
    context,
    documents,
    databaseState.entries,
  );

  // Pass 1: make sure every markdown file has a Notion page id before rendering
  // content, so relative .md links can resolve to Notion URLs on first sync.
  for (const documentEntry of documents) {
    try {
      await ensureDatabasePageExists(
        context,
        databaseState,
        repo,
        documentEntry,
        knownPageUrls,
      );
    } catch (error) {
      core.warning(
        `Failed to ensure Notion page for ${documentEntry.relPath}: ${describeError(error)}`,
      );
    }
  }

  // Pass 2: render and sync page bodies with a complete path -> Notion URL map.
  const syncedPages: SyncedPage[] = [];
  for (const documentEntry of documents) {
    try {
      const syncedPage = await syncDocumentToDatabase(
        context,
        databaseState,
        repo,
        documentEntry,
        knownPageUrls,
      );
      if (syncedPage) {
        syncedPages.push(syncedPage);
      }
    } catch (error) {
      core.warning(`Failed to sync ${documentEntry.relPath}: ${describeError(error)}`);
    }
  }

  const currentDocumentPaths = getCurrentDatabaseDocumentPaths(context, documents);
  await removeStaleSyncStateEntries(context.notion, databaseState.entries, currentDocumentPaths);
}

async function ensureDatabasePageExists(
  context: RuntimeContext,
  databaseState: DatabaseSyncState,
  repo: string,
  documentEntry: MarkdownDocument,
  knownPageUrls: Map<string, string>,
): Promise<void> {
  if (knownPageUrls.has(documentEntry.absPath)) {
    return;
  }

  const documentPath = getDatabaseDocumentPath(context, documentEntry);
  const pageTitle = buildNotionPageTitle(documentEntry, context.titlePrefixSeparator);
  const existingSyncStateEntry = databaseState.entries.get(documentPath);
  let pageId = existingSyncStateEntry?.pageId ?? documentEntry.notionPageId;

  if (!pageId) {
    const matchedPageId = databaseState.pageIdsByTitle.get(pageTitle);
    if (matchedPageId) {
      pageId = matchedPageId;
    }
  }

  if (!pageId) {
    const documentLog = createLogContext(documentEntry.relPath);
    const created = await createDataSourcePage(
      context.notion,
      databaseState.dataSourceId,
      buildDatabasePageProperties(
        databaseState.propertyNames,
        repo,
        context.docsFolder,
        documentPath,
        pageTitle,
        undefined,
      ),
    );
    pageId = normalizeNotionId(created.id);
    documentLog.info(`Created database page shell: ${pageTitle}`);
    databaseState.entries.set(documentPath, {
      pageId,
      title: pageTitle,
    });
    knownPageUrls.set(documentEntry.absPath, created.url || notionPageUrl(pageId));
    return;
  }

  const normalizedPageId = normalizeNotionId(pageId);
  databaseState.entries.set(documentPath, {
    pageId: normalizedPageId,
    sourceHash: existingSyncStateEntry?.sourceHash,
    title: existingSyncStateEntry?.title ?? pageTitle,
  });
  knownPageUrls.set(documentEntry.absPath, notionPageUrl(normalizedPageId));
}

async function syncDocumentToDatabase(
  context: RuntimeContext,
  databaseState: DatabaseSyncState,
  repo: string,
  documentEntry: MarkdownDocument,
  knownPageUrls: Map<string, string>,
): Promise<SyncedPage | null> {
  const documentLog = createLogContext(documentEntry.relPath);
  documentLog.info(`Sync start: ${documentEntry.title}`);

  const documentPath = getDatabaseDocumentPath(context, documentEntry);
  const pageTitle = buildNotionPageTitle(documentEntry, context.titlePrefixSeparator);
  const existingSyncStateEntry = databaseState.entries.get(documentPath);
  let pageId = existingSyncStateEntry?.pageId ?? documentEntry.notionPageId;
  let pageUrl = pageId ? notionPageUrl(pageId) : documentEntry.notionUrl;

  if (!pageId) {
    const matchedPageId = databaseState.pageIdsByTitle.get(pageTitle);
    if (matchedPageId) {
      pageId = matchedPageId;
      pageUrl = notionPageUrl(matchedPageId);
      documentLog.info(`Matched existing Notion database page by generated title: ${pageTitle}`);
    }
  }

  const requiresForcedSync =
    !existingSyncStateEntry ||
    existingSyncStateEntry.sourceHash !== documentEntry.sourceHash ||
    existingSyncStateEntry.title !== pageTitle;

  if (pageId) {
    const isUnchanged =
      existingSyncStateEntry?.sourceHash === documentEntry.sourceHash &&
      existingSyncStateEntry.title === pageTitle;
    if (isUnchanged) {
      documentLog.info("Skipping sync: source hash unchanged.");
      pageUrl ??= notionPageUrl(pageId);
    } else {
      const decision = await getSyncDecision(
        context.notion,
        pageId,
        documentEntry.absPath,
        context.githubToken,
        context.workspaceRoot,
        documentLog,
      );

      if (!requiresForcedSync && decision.skipSync) {
        documentLog.info("Skipping sync: Notion is up to date.");
        pageUrl ??= notionPageUrl(pageId);
      } else if (decision.archivedOrMissing) {
        documentLog.warn(`Notion page missing or archived, recreating: ${pageTitle}`);
        pageId = undefined;
      } else {
        try {
          await updateDatabasePage(
            context,
            databaseState,
            repo,
            documentEntry,
            pageTitle,
            pageId,
            knownPageUrls,
          );
          pageUrl = notionPageUrl(pageId);
          documentLog.info(`Updated page: ${pageTitle}`);
        } catch (error) {
          if (!isNotionArchivedError(error) && !isNotionNotFoundError(error)) {
            throw error;
          }
          documentLog.warn(`Notion page missing or archived, recreating: ${pageTitle}`);
          pageId = undefined;
        }
      }
    }
  }

  if (!pageId) {
    const created = await createDatabasePage(
      context,
      databaseState,
      repo,
      documentEntry,
      pageTitle,
      knownPageUrls,
    );
    pageId = created.pageId;
    pageUrl = created.pageUrl;
  }

  if (!pageId || !pageUrl) {
    return null;
  }

  const normalizedPageId = normalizeNotionId(pageId);
  databaseState.entries.set(documentPath, {
    pageId: normalizedPageId,
    sourceHash: documentEntry.sourceHash,
    title: pageTitle,
  });
  knownPageUrls.set(documentEntry.absPath, pageUrl);
  return { pageId: normalizedPageId, title: pageTitle };
}

async function updateDatabasePage(
  context: RuntimeContext,
  databaseState: DatabaseSyncState,
  repo: string,
  documentEntry: MarkdownDocument,
  pageTitle: string,
  pageId: string,
  knownPageUrls: Map<string, string>,
): Promise<void> {
  const documentPath = getDatabaseDocumentPath(context, documentEntry);
  const documentLog = createLogContext(documentEntry.relPath);
  const propertiesBeforeContent = buildDatabasePageProperties(
    databaseState.propertyNames,
    repo,
    context.docsFolder,
    documentPath,
    pageTitle,
    undefined,
  );
  const blocks = await buildBlocksForDocument(
    context.notion,
    documentEntry,
    context.docsFolderPath,
    context.workspaceRoot,
    knownPageUrls,
    context.githubToken,
    documentLog,
  );
  await updateDataSourcePageContent(
    context.notion,
    pageId,
    propertiesBeforeContent,
    blocks,
    documentLog,
  );
  await updateDataSourcePageProperties(
    context.notion,
    pageId,
    buildDatabasePageProperties(
      databaseState.propertyNames,
      repo,
      context.docsFolder,
      documentPath,
      pageTitle,
      documentEntry.sourceHash,
    ),
  );
}

async function createDatabasePage(
  context: RuntimeContext,
  databaseState: DatabaseSyncState,
  repo: string,
  documentEntry: MarkdownDocument,
  pageTitle: string,
  knownPageUrls: Map<string, string>,
): Promise<{ pageId: string; pageUrl: string }> {
  const documentPath = getDatabaseDocumentPath(context, documentEntry);
  const documentLog = createLogContext(documentEntry.relPath);
  const created = await createDataSourcePage(
    context.notion,
    databaseState.dataSourceId,
    buildDatabasePageProperties(
      databaseState.propertyNames,
      repo,
      context.docsFolder,
      documentPath,
      pageTitle,
      undefined,
    ),
  );
  const pageId = normalizeNotionId(created.id);
  const pageUrl = created.url || notionPageUrl(pageId);
  documentLog.info(`Created database page: ${pageTitle}`);
  documentLog.info(`Page URL: ${pageUrl}`);

  databaseState.entries.set(documentPath, {
    pageId,
    title: pageTitle,
  });

  const blocks = await buildBlocksForDocument(
    context.notion,
    documentEntry,
    context.docsFolderPath,
    context.workspaceRoot,
    knownPageUrls,
    context.githubToken,
    documentLog,
  );
  await appendBlocksSafe(context.notion, pageId, blocks, documentLog);
  await updateDataSourcePageProperties(
    context.notion,
    pageId,
    buildDatabasePageProperties(
      databaseState.propertyNames,
      repo,
      context.docsFolder,
      documentPath,
      pageTitle,
      documentEntry.sourceHash,
    ),
  );
  return { pageId, pageUrl };
}

async function syncPageMode(
  context: RuntimeContext,
  pageInput: string,
  pageBlockInput: string,
): Promise<void> {
  const pageBlockId = pageBlockInput ? normalizeNotionId(pageBlockInput) : null;
  const pageBlockParentId = pageBlockId
    ? await resolveParentPageId(context.notion, pageBlockId)
    : null;
  const pagesParentId = pageInput ? normalizeNotionId(pageInput) : pageBlockParentId;
  if (!pagesParentId) {
    throw new Error("Either database_id, page_block_id, or page_id must be provided.");
  }

  const syncState = await loadSyncState(context.notion, pagesParentId);
  const documents = await loadDocuments(context, syncState.entries);
  const knownPageUrls = buildKnownPageUrls(documents);
  const syncedPages: SyncedPage[] = [];
  let isSyncStateDirty = false;

  for (const documentEntry of documents) {
    try {
      const result = await syncDocumentToPage(
        context,
        syncState,
        pagesParentId,
        documentEntry,
        knownPageUrls,
      );
      if (result.syncedPage) {
        syncedPages.push(result.syncedPage);
      }
      isSyncStateDirty ||= result.syncStateDirty;
    } catch (error) {
      core.warning(`Failed to sync ${documentEntry.relPath}: ${describeError(error)}`);
    }
  }

  if (pageBlockId && pageBlockParentId && syncedPages.length > 0) {
    await appendPageLinksAfterAnchor(
      context.notion,
      pageBlockParentId,
      pageBlockId,
      syncedPages,
      createLogContext("index"),
    );
  }

  const removedStaleEntries = await removeStaleSyncStateEntries(
    context.notion,
    syncState.entries,
    getCurrentDocumentPaths(documents),
  );
  isSyncStateDirty ||= removedStaleEntries;

  if (isSyncStateDirty) {
    await writeSyncState(context.notion, syncState.pageId, syncState.entries);
  } else {
    core.info("Sync state unchanged.");
  }
}

type PageSyncState = Awaited<ReturnType<typeof loadSyncState>>;

async function syncDocumentToPage(
  context: RuntimeContext,
  syncState: PageSyncState,
  pagesParentId: string,
  documentEntry: MarkdownDocument,
  knownPageUrls: Map<string, string>,
): Promise<{ syncStateDirty: boolean; syncedPage: SyncedPage | null }> {
  const documentLog = createLogContext(documentEntry.relPath);
  documentLog.info(`Sync start: ${documentEntry.title}`);
  const documentPath = normalizeDocumentPath(documentEntry.relPath);
  const pageTitle = buildNotionPageTitle(documentEntry, context.titlePrefixSeparator);
  let pageId = documentEntry.notionPageId;
  let pageUrl = documentEntry.notionUrl;
  const existingSyncStateEntry = syncState.entries.get(documentPath);
  let isSyncStateDirty = false;

  const requiresForcedSync =
    !existingSyncStateEntry?.sourceHash || existingSyncStateEntry.title !== pageTitle;
  if (
    pageId &&
    existingSyncStateEntry?.pageId &&
    !syncState.childPageIds.has(normalizeNotionId(pageId))
  ) {
    documentLog.warn("Notion page no longer exists under the target parent, recreating.");
    pageId = undefined;
    pageUrl = undefined;
  }

  if (!pageId) {
    const matchedPageId = syncState.childPageIdsByTitle.get(pageTitle);
    if (matchedPageId) {
      pageId = matchedPageId;
      pageUrl = notionPageUrl(matchedPageId);
      documentLog.info(`Matched existing Notion child page by generated title: ${pageTitle}`);
    }
  }

  if (pageId) {
    if (
      existingSyncStateEntry?.sourceHash === documentEntry.sourceHash &&
      existingSyncStateEntry.title === pageTitle
    ) {
      documentLog.info("Skipping sync: source hash unchanged.");
      pageUrl ??= notionPageUrl(pageId);
    } else {
      const decision = await getSyncDecision(
        context.notion,
        pageId,
        documentEntry.absPath,
        context.githubToken,
        context.workspaceRoot,
        documentLog,
      );

      if (!requiresForcedSync && decision.skipSync) {
        documentLog.info("Skipping sync: Notion is up to date.");
        pageUrl ??= notionPageUrl(pageId);
      } else if (decision.archivedOrMissing) {
        documentLog.warn(`Notion page missing or archived, recreating: ${pageTitle}`);
        pageId = undefined;
      } else {
        try {
          const blocks = await buildBlocksForDocument(
            context.notion,
            documentEntry,
            context.docsFolderPath,
            context.workspaceRoot,
            knownPageUrls,
            context.githubToken,
            documentLog,
          );
          await updatePageContent(context.notion, pageId, pageTitle, blocks, documentLog);
          pageUrl = notionPageUrl(pageId);
          documentLog.info(`Updated page: ${pageTitle}`);
        } catch (error) {
          if (!isNotionArchivedError(error) && !isNotionNotFoundError(error)) {
            throw error;
          }
          documentLog.warn(`Notion page missing or archived, recreating: ${pageTitle}`);
          pageId = undefined;
        }
      }
    }
  }

  if (!pageId) {
    const created = await createPage(context.notion, pagesParentId, pageTitle);
    pageId = normalizeNotionId(created.id);
    syncState.childPageIds.add(pageId);
    syncState.childPageIdsByTitle.set(pageTitle, pageId);
    pageUrl = created.url || notionPageUrl(pageId);
    documentLog.info(`Created page: ${pageTitle}`);
    documentLog.info(`Page URL: ${pageUrl}`);

    syncState.entries.set(documentPath, {
      pageId,
      title: pageTitle,
    });
    isSyncStateDirty = true;
    await appendSyncStateRecord(context.notion, syncState.pageId, documentPath, {
      pageId,
      title: pageTitle,
    });

    const blocks = await buildBlocksForDocument(
      context.notion,
      documentEntry,
      context.docsFolderPath,
      context.workspaceRoot,
      knownPageUrls,
      context.githubToken,
      documentLog,
    );
    await appendBlocksSafe(context.notion, pageId, blocks, documentLog);
  }

  if (!pageId || !pageUrl) {
    return { syncStateDirty: isSyncStateDirty, syncedPage: null };
  }

  const normalizedPageId = normalizeNotionId(pageId);
  if (
    !existingSyncStateEntry ||
    normalizeNotionId(existingSyncStateEntry.pageId) !== normalizedPageId ||
    existingSyncStateEntry.sourceHash !== documentEntry.sourceHash ||
    existingSyncStateEntry.title !== pageTitle
  ) {
    syncState.entries.set(documentPath, {
      pageId: normalizedPageId,
      sourceHash: documentEntry.sourceHash,
      title: pageTitle,
    });
    isSyncStateDirty = true;
  }

  knownPageUrls.set(documentEntry.absPath, pageUrl);
  return {
    syncStateDirty: isSyncStateDirty,
    syncedPage: { pageId: normalizedPageId, title: pageTitle },
  };
}

async function loadDocuments(
  context: RuntimeContext,
  syncStateEntries: Map<string, SyncStateEntry>,
): Promise<MarkdownDocument[]> {
  const markdownFiles = await collectMarkdownFiles(
    context.docsFolderPath,
    context.privateMarkdownPrefix,
    context.excludeGlobs,
    context.workspaceRoot,
  );
  if (markdownFiles.length === 0) {
    core.warning(`No markdown files found in ${context.docsFolderPath}.`);
  }
  return loadMarkdownDocuments(markdownFiles, context.docsFolderPath, syncStateEntries);
}

function buildKnownPageUrls(documents: MarkdownDocument[]): Map<string, string> {
  const knownPageUrls = new Map<string, string>();
  for (const documentEntry of documents) {
    if (documentEntry.notionPageId) {
      knownPageUrls.set(documentEntry.absPath, notionPageUrl(documentEntry.notionPageId));
    }
  }
  return knownPageUrls;
}

function buildKnownPageUrlsFromSyncEntries(
  context: RuntimeContext,
  documents: MarkdownDocument[],
  syncStateEntries: Map<string, SyncStateEntry>,
): Map<string, string> {
  const knownPageUrls = new Map<string, string>();
  for (const documentEntry of documents) {
    const syncStateEntry = syncStateEntries.get(getDatabaseDocumentPath(context, documentEntry));
    if (syncStateEntry?.pageId) {
      knownPageUrls.set(documentEntry.absPath, notionPageUrl(syncStateEntry.pageId));
    }
  }
  return knownPageUrls;
}

function getCurrentDocumentPaths(documents: MarkdownDocument[]): Set<string> {
  return new Set(documents.map((documentEntry) => normalizeDocumentPath(documentEntry.relPath)));
}

function getCurrentDatabaseDocumentPaths(
  context: RuntimeContext,
  documents: MarkdownDocument[],
): Set<string> {
  return new Set(documents.map((documentEntry) => getDatabaseDocumentPath(context, documentEntry)));
}

function getDatabaseDocumentPath(context: RuntimeContext, documentEntry: MarkdownDocument): string {
  return normalizeDocumentPath(path.relative(context.workspaceRoot, documentEntry.absPath));
}

async function removeStaleSyncStateEntries(
  notion: Client,
  syncStateEntries: Map<string, SyncStateEntry>,
  currentDocumentPaths: Set<string>,
): Promise<boolean> {
  const staleEntries = [...syncStateEntries].filter(
    ([documentPath]) => !currentDocumentPaths.has(documentPath),
  );
  if (staleEntries.length === 0) {
    return false;
  }

  const activePageIds = new Set<string>();
  for (const [documentPath, syncStateEntry] of syncStateEntries) {
    if (!currentDocumentPaths.has(documentPath)) {
      continue;
    }
    activePageIds.add(normalizeNotionId(syncStateEntry.pageId));
  }

  let isRemovedEntries = false;
  for (const [stalePath, staleEntry] of staleEntries) {
    const staleLog = createLogContext(stalePath);
    const normalizedPageId = normalizeNotionId(staleEntry.pageId);
    if (activePageIds.has(normalizedPageId)) {
      staleLog.info(
        `Removing stale sync state record for path that no longer exists. Page ${normalizedPageId} is still referenced by another active markdown file.`,
      );
    } else {
      staleLog.info(
        "Markdown file no longer exists. Archiving the mapped Notion page and removing the stale sync state record.",
      );
      await archivePageIfPresent(notion, normalizedPageId, staleLog);
    }
    syncStateEntries.delete(stalePath);
    isRemovedEntries = true;
  }

  return isRemovedEntries;
}

await run();
