import type { Client } from "@notionhq/client";

import { syncPageBlocks } from "./block-sync.js";
import { getLastCommitTime } from "./git-utils.js";
import { defaultLogContext } from "./logging.js";
import { describeError } from "./logging.js";
import {
  isNotionArchivedError,
  isNotionBlockArchivedError,
  isNotionNotFoundError,
  isTransientNotionError,
  normalizeNotionId,
  notionRequest,
  toDashedId,
} from "./notion-api.js";
import type { LogContext } from "./logging.js";
import type { NotionBlock } from "./notion-types.js";

type SyncDecision = {
  archivedOrMissing: boolean;
  skipSync: boolean;
};

type CreatePageRequest = Parameters<Client["pages"]["create"]>[0];
type PageProperties = CreatePageRequest["properties"];
type UpdatePageRequest = Parameters<Client["pages"]["update"]>[0];

const NOTION_SYNC_BUFFER_MS = 60_000;

export async function resolveParentPageId(notion: Client, blockId: string): Promise<string> {
  let currentBlockId = toDashedId(blockId);
  for (let depth = 0; depth < 10; depth += 1) {
    const block = await notionRequest(
      () => notion.blocks.retrieve({ block_id: currentBlockId }),
      `blocks.retrieve ${currentBlockId}`,
    );
    if (!("parent" in block)) {
      throw new Error("Unable to resolve parent for index block.");
    }

    const parent = block.parent;
    if (parent.type === "page_id") {
      return normalizeNotionId(parent.page_id);
    }
    if (parent.type === "block_id") {
      currentBlockId = parent.block_id;
      continue;
    }

    throw new Error(`Index block parent type ${parent.type} is not supported.`);
  }

  throw new Error("Index block parent resolution exceeded depth limit.");
}

export async function createPage(
  notion: Client,
  parentPageId: string,
  title: string,
): Promise<{ id: string; url?: string | null }> {
  const response = await notionRequest(
    () =>
      notion.pages.create({
        parent: { page_id: toDashedId(parentPageId) },
        properties: buildTitleProperty(title),
      }),
    `pages.create ${parentPageId}`,
  );

  return {
    id: response.id,
    url: "url" in response ? response.url : null,
  };
}

export async function createDataSourcePage(
  notion: Client,
  dataSourceId: string,
  properties: PageProperties,
): Promise<{ id: string; url?: string | null }> {
  const response = await notionRequest(
    () =>
      notion.pages.create({
        parent: { data_source_id: toDashedId(dataSourceId) },
        properties,
      }),
    `pages.create data_source ${dataSourceId}`,
  );

  return {
    id: response.id,
    url: "url" in response ? response.url : null,
  };
}

export async function archivePageIfPresent(
  notion: Client,
  pageId: string,
  logContext: LogContext = defaultLogContext,
): Promise<"already-gone" | "archived"> {
  try {
    await notionRequest(
      () =>
        notion.pages.update({
          in_trash: true,
          page_id: toDashedId(pageId),
        }),
      `pages.update trash ${pageId}`,
    );
    logContext.info(`Archived stale page: ${pageId}`);
    return "archived";
  } catch (error) {
    if (isNotionArchivedError(error) || isNotionNotFoundError(error)) {
      logContext.info(`Stale page already missing or archived: ${pageId}`);
      return "already-gone";
    }
    throw error;
  }
}

export async function updatePageContent(
  notion: Client,
  pageId: string,
  title: string,
  blocks: NotionBlock[],
  logContext: LogContext = defaultLogContext,
): Promise<void> {
  logContext.info(`Updating page metadata for ${pageId}...`);
  await notionRequest(
    () =>
      notion.pages.update({
        page_id: toDashedId(pageId),
        properties: buildTitleProperty(title),
      }),
    `pages.update ${pageId}`,
  );

  logContext.info(`Starting block sync for ${pageId}...`);
  await syncPageBlocks(notion, pageId, blocks, logContext);
}

export async function updateDataSourcePageContent(
  notion: Client,
  pageId: string,
  properties: UpdatePageRequest["properties"],
  blocks: NotionBlock[],
  logContext: LogContext = defaultLogContext,
): Promise<void> {
  logContext.info(`Updating database page metadata for ${pageId}...`);
  await notionRequest(
    () =>
      notion.pages.update({
        page_id: toDashedId(pageId),
        properties,
      }),
    `pages.update ${pageId}`,
  );

  logContext.info(`Starting block sync for ${pageId}...`);
  await syncPageBlocks(notion, pageId, blocks, logContext);
}

export async function updateDataSourcePageProperties(
  notion: Client,
  pageId: string,
  properties: UpdatePageRequest["properties"],
): Promise<void> {
  await notionRequest(
    () =>
      notion.pages.update({
        page_id: toDashedId(pageId),
        properties,
      }),
    `pages.update ${pageId}`,
  );
}

async function isNotionPageGone(notion: Client, pageId: string): Promise<boolean> {
  try {
    const page = await notionRequest(
      () => notion.pages.retrieve({ page_id: toDashedId(pageId) }),
      `pages.retrieve ${pageId}`,
    );
    return isArchivedOrTrashedPage(page);
  } catch (error) {
    if (isNotionNotFoundError(error)) {
      return true;
    }
    throw error;
  }
}

export async function updateNotionPageWithRecovery(
  notion: Client,
  pageId: string,
  pageTitle: string,
  logContext: LogContext,
  update: () => Promise<void>,
): Promise<"recreate" | "updated"> {
  try {
    await update();
    return "updated";
  } catch (error) {
    const decision = await classifyPageUpdateFailure(notion, pageId, error, logContext);
    if (decision === "recreate") {
      return "recreate";
    }
    if (decision !== "retry") {
      throw error;
    }

    logContext.warn(
      `Retrying Notion update for ${pageTitle} after a block-level or transient error: ${describeError(error)}`,
    );
    try {
      await update();
      return "updated";
    } catch (retryError) {
      const retryDecision = await classifyPageUpdateFailure(notion, pageId, retryError, logContext);
      if (retryDecision === "recreate") {
        return "recreate";
      }
      throw retryError;
    }
  }
}

async function classifyPageUpdateFailure(
  notion: Client,
  pageId: string,
  error: unknown,
  logContext: LogContext,
): Promise<"recreate" | "retry" | "throw"> {
  try {
    if (await isNotionPageGone(notion, pageId)) {
      return "recreate";
    }
  } catch (retrieveError) {
    logContext.warn(
      `Unable to confirm whether Notion page ${pageId} still exists: ${describeError(retrieveError)}`,
    );
    return "throw";
  }

  if (isRetryablePageUpdateError(error)) {
    return "retry";
  }
  return "throw";
}

function isRetryablePageUpdateError(error: unknown): boolean {
  return (
    isNotionBlockArchivedError(error) ||
    isNotionArchivedError(error) ||
    isNotionNotFoundError(error) ||
    isTransientNotionError(error)
  );
}

function isArchivedOrTrashedPage(page: object): boolean {
  const isArchived = "archived" in page && page.archived === true;
  const isInTrash = "in_trash" in page && page.in_trash === true;
  return isArchived || isInTrash;
}

export async function getSyncDecision(
  notion: Client,
  pageId: string,
  filePath: string,
  githubToken: string | null,
  workspaceRoot: string,
  logContext: LogContext = defaultLogContext,
): Promise<SyncDecision> {
  const lastCommitTime = await getLastCommitTime(filePath, workspaceRoot, githubToken);
  if (!lastCommitTime) {
    logContext.warn(`Unable to read git commit time for ${filePath}. Syncing.`);
  }

  let page: Awaited<ReturnType<Client["pages"]["retrieve"]>>;
  try {
    page = await notionRequest(
      () => notion.pages.retrieve({ page_id: toDashedId(pageId) }),
      `pages.retrieve ${pageId}`,
    );
  } catch (error) {
    if (isNotionNotFoundError(error)) {
      return { archivedOrMissing: true, skipSync: false };
    }
    throw error;
  }

  if (isArchivedOrTrashedPage(page)) {
    return { archivedOrMissing: true, skipSync: false };
  }
  if (!lastCommitTime) {
    return { archivedOrMissing: false, skipSync: false };
  }

  const lastEdited = "last_edited_time" in page ? page.last_edited_time : null;
  if (!lastEdited) {
    return { archivedOrMissing: false, skipSync: false };
  }

  const notionTime = new Date(lastEdited);
  if (Number.isNaN(notionTime.getTime())) {
    return { archivedOrMissing: false, skipSync: false };
  }

  return {
    archivedOrMissing: false,
    skipSync: lastCommitTime.getTime() <= notionTime.getTime() + NOTION_SYNC_BUFFER_MS,
  };
}

function buildTitleProperty(title: string): PageProperties {
  return {
    title: {
      title: [
        {
          type: "text",
          text: { content: title },
        },
      ],
    },
  } as PageProperties;
}
