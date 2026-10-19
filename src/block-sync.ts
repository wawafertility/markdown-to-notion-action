import type { Client } from "@notionhq/client";

import { defaultLogContext } from "./logging.js";
import {
  type AppendChildren,
  type BlockUpdateRequest,
  type CalloutIconRequest,
  type PartialBlockObjectResponse,
  isNotionBlockArchivedError,
  isNotionNotFoundError,
  listAllChildren,
  normalizeNotionId,
  normalizeNotionIdValue,
  notionRequest,
  toDashedId,
} from "./notion-api.js";
import { getBlockChildren } from "./notion-block-utils.js";
import type { LogContext } from "./logging.js";
import type { NotionBlock } from "./notion-types.js";
import type { SyncedPage } from "./sync-types.js";

type BlockSyncStats = {
  appended: number;
  deleted: number;
  replaced: number;
  unchanged: number;
  updated: number;
};

type BlockSyncResult = {
  action: "replaced" | "unchanged" | "updated";
  newBlockId?: string;
};

type NormalizedAnnotations = {
  bold?: true;
  code?: true;
  color?: string;
  italic?: true;
  strikethrough?: true;
  underline?: true;
};

type NormalizedRichTextItem =
  | {
      annotations?: NormalizedAnnotations;
      text: { content: string; link?: { url: string } };
      type: "text";
    }
  | { type: string };

type NormalizedBlock = {
  content: unknown;
  type: string;
};

async function clearChildren(
  notion: Client,
  blockId: string,
  logContext: LogContext = defaultLogContext,
): Promise<void> {
  logContext.info(`Starting block deletion for ${blockId}...`);
  const children = await listAllChildren(notion, blockId);
  if (children.length === 0) {
    logContext.info("No existing blocks to clear.");
    return;
  }

  const concurrencyLimit = 3;
  logContext.info(`Deleting ${children.length} existing blocks...`);
  await deleteBlocks(notion, children, logContext, concurrencyLimit);

  logContext.info("Finished clearing page.");
}

export async function syncPageBlocks(
  notion: Client,
  pageId: string,
  blocks: NotionBlock[],
  logContext: LogContext = defaultLogContext,
): Promise<void> {
  if (blocks.length === 0) {
    await clearChildren(notion, pageId, logContext);
    return;
  }

  logContext.info(`Loading existing blocks for ${pageId}...`);
  const existingChildren = await listAllChildren(notion, pageId);
  if (existingChildren.length === 0) {
    await appendBlocksSafe(notion, pageId, blocks, logContext);
    return;
  }

  logContext.info(
    `Syncing ${blocks.length} blocks with ${existingChildren.length} existing blocks.`,
  );

  const stats: BlockSyncStats = {
    appended: 0,
    deleted: 0,
    replaced: 0,
    unchanged: 0,
    updated: 0,
  };

  const sharedCount = Math.min(existingChildren.length, blocks.length);
  let lastBlockId: string | null = null;

  for (let index = 0; index < sharedCount; index += 1) {
    const existing = existingChildren[index];
    const existingId = getBlockId(existing);
    if (!existingId) {
      logContext.warn("Skipping existing block with missing id.");
      continue;
    }

    const incoming = blocks[index];
    const result = await syncBlockPair(notion, pageId, existing, incoming, logContext, lastBlockId);
    switch (result.action) {
      case "unchanged": {
        stats.unchanged += 1;
        lastBlockId = existingId;
        break;
      }
      case "updated": {
        stats.updated += 1;
        lastBlockId = existingId;
        break;
      }
      case "replaced": {
        stats.replaced += 1;
        lastBlockId = result.newBlockId ?? existingId;
        break;
      }
    }
  }

  if (blocks.length > existingChildren.length) {
    const remaining = blocks.slice(sharedCount);
    if (remaining.length > 0) {
      if (lastBlockId) {
        await appendBlocksAfter(notion, pageId, lastBlockId, remaining, logContext);
      } else {
        await appendBlocksSafe(notion, pageId, remaining, logContext);
      }
      stats.appended += remaining.length;
    }
  }

  if (existingChildren.length > blocks.length) {
    const remainingExisting = existingChildren.slice(sharedCount);
    stats.deleted += await deleteBlocks(notion, remainingExisting, logContext);
  }

  logContext.info(
    `Block sync complete. Unchanged: ${stats.unchanged}, updated: ${stats.updated}, replaced: ${stats.replaced}, appended: ${stats.appended}, deleted: ${stats.deleted}.`,
  );
}

export async function appendBlocksSafe(
  notion: Client,
  blockId: string,
  blocks: NotionBlock[],
  logContext: LogContext = defaultLogContext,
): Promise<void> {
  if (blocks.length === 0) {
    return;
  }

  logContext.info(`Starting block creation for ${blockId} (${blocks.length} blocks).`);
  const chunks = chunkArray(blocks, 50);
  for (const chunk of chunks) {
    const requestChunk = toNotionBlockRequests(chunk);
    try {
      await notionRequest(
        () =>
          notion.blocks.children.append({
            block_id: toDashedId(blockId),
            children: requestChunk,
          }),
        `blocks.children.append ${blockId}`,
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logContext.warn(`Chunk append failed: ${message}. Retrying block-by-block.`);
      for (const block of chunk) {
        try {
          await notionRequest(
            () =>
              notion.blocks.children.append({
                block_id: toDashedId(blockId),
                children: toNotionBlockRequests([block]),
              }),
            `blocks.children.append ${blockId}`,
          );
        } catch (blockError) {
          const blockMessage =
            blockError instanceof Error ? blockError.message : String(blockError);
          throw new Error(`Failed to append block (${block.type}): ${blockMessage}`);
        }
      }
    }
  }
}

export async function appendPageLinksAfterAnchor(
  notion: Client,
  parentPageId: string,
  anchorBlockId: string,
  pages: SyncedPage[],
  logContext: LogContext = defaultLogContext,
): Promise<void> {
  logContext.info(`Starting index link sync for anchor ${anchorBlockId}...`);
  const existingChildren = await listAllChildren(notion, parentPageId);
  const anchorId = normalizeNotionId(anchorBlockId);
  const anchorIndex = existingChildren.findIndex((child) => {
    const childId = getBlockId(child);
    if (!childId) {
      return false;
    }

    try {
      return normalizeNotionId(childId) === anchorId;
    } catch {
      return false;
    }
  });
  if (anchorIndex === -1) {
    throw new Error(`Index anchor block ${anchorBlockId} not found in parent page.`);
  }

  const existingLinkBlocks: PartialBlockObjectResponse[] = [];
  for (let index = anchorIndex + 1; index < existingChildren.length; index += 1) {
    const child = existingChildren[index];
    if (getBlockType(child) !== "link_to_page") {
      break;
    }
    existingLinkBlocks.push(child);
  }

  const blocks: NotionBlock[] = [];
  const desiredPageIds: string[] = [];
  const seenPageIds = new Set<string>();
  for (const page of pages) {
    const normalizedId = normalizeNotionId(page.pageId);
    if (seenPageIds.has(normalizedId)) {
      continue;
    }

    seenPageIds.add(normalizedId);
    desiredPageIds.push(normalizedId);
    blocks.push({
      type: "link_to_page",
      link_to_page: {
        type: "page_id",
        page_id: toDashedId(normalizedId),
      },
    });
  }

  const existingPageIds = existingLinkBlocks.map((block) => getLinkToPageId(block));
  if (arePageIdListsEqual(existingPageIds, desiredPageIds)) {
    logContext.info("Index links unchanged.");
    return;
  }

  if (existingLinkBlocks.length > 0) {
    logContext.info(`Replacing ${existingLinkBlocks.length} index link blocks.`);
    await deleteBlocks(notion, existingLinkBlocks, logContext);
  }

  if (blocks.length === 0) {
    logContext.info("Index anchor cleared. No pages to link.");
    return;
  }

  await appendBlocksAfter(notion, parentPageId, anchorBlockId, blocks, logContext);
}

async function syncBlockPair(
  notion: Client,
  parentPageId: string,
  existing: PartialBlockObjectResponse,
  incoming: NotionBlock,
  logContext: LogContext,
  afterBlockId: string | null,
): Promise<BlockSyncResult> {
  const existingId = getBlockId(existing);
  const existingType = getBlockType(existing);
  if (!existingId || !existingType) {
    return { action: "unchanged" };
  }

  try {
    return await syncLiveBlockPair(
      notion,
      parentPageId,
      existing,
      existingId,
      existingType,
      incoming,
      logContext,
    );
  } catch (error) {
    if (!isNotionBlockArchivedError(error)) {
      throw error;
    }
    logContext.warn(
      `Block ${existingId} is archived. Appending a replacement without recreating the page.`,
    );
    const newBlockId = await appendReplacementForArchivedBlock(
      notion,
      parentPageId,
      afterBlockId,
      incoming,
      logContext,
    );
    return { action: "replaced", newBlockId };
  }
}

async function syncLiveBlockPair(
  notion: Client,
  parentPageId: string,
  existing: PartialBlockObjectResponse,
  existingId: string,
  existingType: string,
  incoming: NotionBlock,
  logContext: LogContext,
): Promise<BlockSyncResult> {
  const incomingChildren = getBlockChildren(incoming);
  const hasExistingChildren = hasExistingBlockChildren(existing);
  const hasChildrenToSync = incomingChildren.length > 0 || hasExistingChildren;

  if (existingType === incoming.type) {
    if (areBlocksEquivalent(existing, incoming)) {
      if (hasChildrenToSync) {
        await syncPageBlocks(notion, existingId, incomingChildren, logContext);
        return { action: "updated" };
      }
      return { action: "unchanged" };
    }

    if (canUpdateBlockType(incoming.type)) {
      const updated = await updateBlockContent(notion, existingId, incoming, logContext);
      if (updated) {
        if (hasChildrenToSync) {
          await syncPageBlocks(notion, existingId, incomingChildren, logContext);
        }
        return { action: "updated" };
      }
    }
  }

  const newBlockId = await appendSingleBlockAfter(
    notion,
    parentPageId,
    existingId,
    incoming,
    logContext,
  );
  await deleteBlockSafe(notion, existingId, logContext);
  return { action: "replaced", newBlockId };
}

function getBlockId(block: PartialBlockObjectResponse): string | null {
  if (!block || typeof block !== "object") {
    return null;
  }
  const candidate = (block as { id?: unknown }).id;
  return typeof candidate === "string" ? candidate : null;
}

function getBlockType(block: PartialBlockObjectResponse): string | null {
  if (!block || typeof block !== "object") {
    return null;
  }
  const candidate = (block as { type?: unknown }).type;
  return typeof candidate === "string" ? candidate : null;
}

function hasExistingBlockChildren(block: PartialBlockObjectResponse): boolean {
  if (!block || typeof block !== "object") {
    return false;
  }
  const hasChildren = (block as { has_children?: unknown }).has_children;
  return hasChildren === true;
}

function canUpdateBlockType(type: string): boolean {
  return [
    "paragraph",
    "heading_1",
    "heading_2",
    "heading_3",
    "bulleted_list_item",
    "numbered_list_item",
    "quote",
    "callout",
    "toggle",
    "to_do",
    "code",
    "equation",
    "table_of_contents",
  ].includes(type);
}

async function updateBlockContent(
  notion: Client,
  blockId: string,
  block: NotionBlock,
  logContext: LogContext,
): Promise<boolean> {
  const request = buildBlockUpdateRequest(blockId, block);
  if (!request) {
    return false;
  }

  try {
    await notionRequest(() => notion.blocks.update(request), `blocks.update ${blockId}`);
    return true;
  } catch (error) {
    if (isNotionNotFoundError(error) || isNotionBlockArchivedError(error)) {
      throw error;
    }
    const message = error instanceof Error ? error.message : String(error);
    logContext.warn(`Block update failed for ${blockId}: ${message}. Replacing block.`);
    return false;
  }
}

function buildBlockUpdateRequest(blockId: string, block: NotionBlock): BlockUpdateRequest | null {
  const dashedId = toDashedId(blockId);
  switch (block.type) {
    case "paragraph": {
      return {
        block_id: dashedId,
        paragraph: {
          rich_text: block.paragraph?.rich_text ?? [],
          color: block.paragraph?.color ?? "default",
        },
      };
    }
    case "heading_1": {
      return {
        block_id: dashedId,
        heading_1: {
          rich_text: block.heading_1?.rich_text ?? [],
          color: block.heading_1?.color ?? "default",
          is_toggleable: block.heading_1?.is_toggleable ?? false,
        },
      };
    }
    case "heading_2": {
      return {
        block_id: dashedId,
        heading_2: {
          rich_text: block.heading_2?.rich_text ?? [],
          color: block.heading_2?.color ?? "default",
          is_toggleable: block.heading_2?.is_toggleable ?? false,
        },
      };
    }
    case "heading_3": {
      return {
        block_id: dashedId,
        heading_3: {
          rich_text: block.heading_3?.rich_text ?? [],
          color: block.heading_3?.color ?? "default",
          is_toggleable: block.heading_3?.is_toggleable ?? false,
        },
      };
    }
    case "bulleted_list_item": {
      return {
        block_id: dashedId,
        bulleted_list_item: {
          rich_text: block.bulleted_list_item?.rich_text ?? [],
          color: block.bulleted_list_item?.color ?? "default",
        },
      };
    }
    case "numbered_list_item": {
      return {
        block_id: dashedId,
        numbered_list_item: {
          rich_text: block.numbered_list_item?.rich_text ?? [],
          color: block.numbered_list_item?.color ?? "default",
        },
      };
    }
    case "quote": {
      return {
        block_id: dashedId,
        quote: {
          rich_text: block.quote?.rich_text ?? [],
          color: block.quote?.color ?? "default",
        },
      };
    }
    case "callout": {
      const icon = toCalloutIconRequest(block.callout?.icon);
      return {
        block_id: dashedId,
        callout: {
          rich_text: block.callout?.rich_text ?? [],
          color: block.callout?.color ?? "default",
          ...(icon && { icon }),
        },
      };
    }
    case "toggle": {
      return {
        block_id: dashedId,
        toggle: {
          rich_text: block.toggle?.rich_text ?? [],
          color: block.toggle?.color ?? "default",
        },
      };
    }
    case "to_do": {
      return {
        block_id: dashedId,
        to_do: {
          rich_text: block.to_do?.rich_text ?? [],
          checked: block.to_do?.checked ?? false,
          color: block.to_do?.color ?? "default",
        },
      };
    }
    case "code": {
      return {
        block_id: dashedId,
        code: {
          rich_text: block.code?.rich_text ?? [],
          language: block.code?.language ?? "plain text",
          caption: block.code?.caption ?? [],
        },
      };
    }
    case "equation": {
      return {
        block_id: dashedId,
        equation: {
          expression: block.equation?.expression ?? "",
        },
      };
    }
    case "table_of_contents": {
      return {
        block_id: dashedId,
        table_of_contents: {
          color: block.table_of_contents?.color ?? "default",
        },
      };
    }
    default: {
      return null;
    }
  }
}

async function appendReplacementForArchivedBlock(
  notion: Client,
  parentPageId: string,
  afterBlockId: string | null,
  block: NotionBlock,
  logContext: LogContext,
): Promise<string> {
  if (afterBlockId) {
    try {
      return await appendSingleBlockAfter(notion, parentPageId, afterBlockId, block, logContext);
    } catch (error) {
      if (!isNotionBlockArchivedError(error)) {
        throw error;
      }
      logContext.warn(
        `Anchor block ${afterBlockId} is archived. Appending the replacement at the end of the page.`,
      );
    }
  }

  return appendSingleBlockAfter(notion, parentPageId, null, block, logContext);
}

async function appendSingleBlockAfter(
  notion: Client,
  parentPageId: string,
  anchorBlockId: string | null,
  block: NotionBlock,
  logContext: LogContext,
): Promise<string> {
  logContext.info(
    anchorBlockId
      ? `Starting single block creation after ${anchorBlockId}.`
      : `Starting single block creation on ${parentPageId}.`,
  );
  const response = await notionRequest(
    () =>
      notion.blocks.children.append({
        block_id: toDashedId(parentPageId),
        children: toNotionBlockRequests([block]),
        ...(anchorBlockId && { after: toDashedId(anchorBlockId) }),
      }),
    `blocks.children.append ${parentPageId}`,
  );
  const last = response.results.at(-1);
  if (last && typeof last === "object" && "id" in last) {
    return (last as { id: string }).id;
  }
  throw new Error("Unable to determine id for appended block.");
}

async function deleteBlocks(
  notion: Client,
  blocks: PartialBlockObjectResponse[],
  logContext: LogContext,
  concurrencyLimit = 3,
): Promise<number> {
  if (blocks.length === 0) {
    return 0;
  }

  logContext.info(`Starting batch delete for ${blocks.length} blocks...`);
  const chunks = chunkArray(blocks, concurrencyLimit);
  let deletedCount = 0;

  for (const chunk of chunks) {
    await Promise.all(
      chunk.map(async (block) => {
        const blockId = getBlockId(block);
        if (!blockId) {
          throw new Error("Cannot delete block with missing id.");
        }
        await deleteBlockSafe(notion, blockId, logContext);
      }),
    );
    deletedCount += chunk.length;
    if (deletedCount % 50 === 0 || deletedCount === blocks.length) {
      logContext.info(`Deleted ${deletedCount}/${blocks.length} trailing blocks...`);
    }
  }

  return deletedCount;
}

async function deleteBlockSafe(
  notion: Client,
  blockId: string,
  logContext: LogContext,
): Promise<void> {
  try {
    await notionRequest(
      () => notion.blocks.delete({ block_id: blockId }),
      `blocks.delete ${blockId}`,
    );
  } catch (error) {
    if (isNotionNotFoundError(error) || isNotionBlockArchivedError(error)) {
      logContext.info(`Block ${blockId} is already missing or archived.`);
      return;
    }
    const message = error instanceof Error ? error.message : String(error);
    logContext.warn(`Failed to delete block ${blockId}: ${message}`);
    throw error instanceof Error ? error : new Error(message);
  }
}

async function appendBlocksAfter(
  notion: Client,
  parentPageId: string,
  anchorBlockId: string,
  blocks: NotionBlock[],
  logContext: LogContext,
): Promise<void> {
  if (blocks.length === 0) {
    return;
  }

  logContext.info(`Starting block creation after ${anchorBlockId} (${blocks.length} blocks).`);
  const chunks = chunkArray(blocks, 50);
  let afterBlockId = toDashedId(anchorBlockId);

  for (const chunk of chunks) {
    const requestChunk = toNotionBlockRequests(chunk);
    try {
      const response = await notionRequest(
        () =>
          notion.blocks.children.append({
            block_id: toDashedId(parentPageId),
            children: requestChunk,
            after: afterBlockId,
          }),
        `blocks.children.append ${parentPageId}`,
      );
      const last = response.results.at(-1);
      if (last && typeof last === "object" && "id" in last) {
        afterBlockId = (last as { id: string }).id;
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logContext.warn(`Chunk append failed: ${message}. Retrying block-by-block.`);
      for (const block of chunk) {
        try {
          const response = await notionRequest(
            () =>
              notion.blocks.children.append({
                block_id: toDashedId(parentPageId),
                children: toNotionBlockRequests([block]),
                after: afterBlockId,
              }),
            `blocks.children.append ${parentPageId}`,
          );
          const last = response.results.at(-1);
          if (last && typeof last === "object" && "id" in last) {
            afterBlockId = (last as { id: string }).id;
          }
        } catch (innerError) {
          const innerMessage =
            innerError instanceof Error ? innerError.message : String(innerError);
          throw new Error(`Block append failed: ${innerMessage}`);
        }
      }
    }
  }
}

function getLinkToPageId(block: PartialBlockObjectResponse): string | null {
  if (getBlockType(block) !== "link_to_page") {
    return null;
  }
  if (!("link_to_page" in block) || typeof block.link_to_page !== "object") {
    return null;
  }

  const linkToPage = block.link_to_page as { page_id?: unknown; type?: unknown };
  if (linkToPage.type !== "page_id" || typeof linkToPage.page_id !== "string") {
    return null;
  }
  return normalizeNotionId(linkToPage.page_id);
}

function arePageIdListsEqual(left: (string | null)[], right: string[]): boolean {
  if (left.length !== right.length) {
    return false;
  }
  return left.every((pageId, index) => pageId === right[index]);
}

function areBlocksEquivalent(existing: PartialBlockObjectResponse, incoming: NotionBlock): boolean {
  const normalizedExisting = normalizeBlockForCompare(existing);
  const normalizedIncoming = normalizeBlockForCompare(incoming);
  if (!normalizedExisting || !normalizedIncoming) {
    return false;
  }
  if (normalizedExisting.type !== normalizedIncoming.type) {
    return false;
  }
  return JSON.stringify(normalizedExisting.content) === JSON.stringify(normalizedIncoming.content);
}

function normalizeBlockForCompare(block: unknown): NormalizedBlock | null {
  if (!block || typeof block !== "object") {
    return null;
  }

  const type = (block as { type?: unknown }).type;
  if (typeof type !== "string") {
    return null;
  }

  const content = (block as Record<string, unknown>)[type];
  const normalized = normalizeBlockContent(type, content);
  if (normalized === null) {
    return null;
  }

  return { content: normalized, type };
}

function normalizeBlockContent(type: string, content: unknown): unknown | null {
  const record = content && typeof content === "object" ? (content as Record<string, unknown>) : {};
  switch (type) {
    case "paragraph":
    case "bulleted_list_item":
    case "numbered_list_item":
    case "quote":
    case "toggle": {
      return {
        color: normalizeColor(record.color),
        rich_text: normalizeRichTextArray(record.rich_text),
      };
    }
    case "heading_1":
    case "heading_2":
    case "heading_3": {
      return {
        color: normalizeColor(record.color),
        is_toggleable: record.is_toggleable === true,
        rich_text: normalizeRichTextArray(record.rich_text),
      };
    }
    case "callout": {
      return {
        color: normalizeColor(record.color),
        icon: normalizeCalloutIcon(record.icon),
        rich_text: normalizeRichTextArray(record.rich_text),
      };
    }
    case "to_do": {
      return {
        checked: record.checked === true,
        color: normalizeColor(record.color),
        rich_text: normalizeRichTextArray(record.rich_text),
      };
    }
    case "divider": {
      return {};
    }
    case "code": {
      return {
        caption: normalizeRichTextArray(record.caption),
        language: typeof record.language === "string" ? record.language : "",
        rich_text: normalizeRichTextArray(record.rich_text),
      };
    }
    case "equation": {
      return {
        expression: typeof record.expression === "string" ? record.expression : "",
      };
    }
    case "image": {
      return {
        caption: normalizeRichTextArray(record.caption),
        type: typeof record.type === "string" ? record.type : "",
        url: extractImageUrl(record),
      };
    }
    case "table_of_contents": {
      return {
        color: normalizeColor(record.color),
      };
    }
    case "link_to_page": {
      return {
        database_id: normalizeNotionIdValue(record.database_id),
        page_id: normalizeNotionIdValue(record.page_id),
        type: typeof record.type === "string" ? record.type : "",
      };
    }
    case "table":
    case "table_row": {
      return null;
    }
    default: {
      return null;
    }
  }
}

function normalizeRichTextArray(value: unknown): NormalizedRichTextItem[] {
  if (!Array.isArray(value)) {
    return [];
  }

  const result: NormalizedRichTextItem[] = [];
  for (const item of value) {
    const normalized = normalizeRichTextItem(item);
    if (normalized) {
      result.push(normalized);
    }
  }
  return result;
}

function normalizeRichTextItem(value: unknown): NormalizedRichTextItem | null {
  if (!value || typeof value !== "object") {
    return null;
  }

  const record = value as Record<string, unknown>;
  const type = typeof record.type === "string" ? record.type : null;
  if (!type) {
    return null;
  }
  if (type !== "text") {
    return { type };
  }

  const text = record.text as { content?: unknown; link?: unknown } | undefined;
  const content = text && typeof text.content === "string" ? text.content : "";
  const link = text && typeof text.link === "object" ? (text.link as { url?: unknown }) : null;
  const linkUrl = link && typeof link.url === "string" ? link.url : null;
  const normalized: NormalizedRichTextItem = {
    text: { content },
    type: "text",
  };
  if (linkUrl) {
    normalized.text.link = { url: linkUrl };
  }

  const annotations = normalizeAnnotations(record.annotations);
  if (annotations) {
    normalized.annotations = annotations;
  }
  return normalized;
}

function normalizeAnnotations(value: unknown): NormalizedAnnotations | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }

  const record = value as Record<string, unknown>;
  const annotations: NormalizedAnnotations = {};
  if (record.bold === true) {
    annotations.bold = true;
  }
  if (record.italic === true) {
    annotations.italic = true;
  }
  if (record.strikethrough === true) {
    annotations.strikethrough = true;
  }
  if (record.underline === true) {
    annotations.underline = true;
  }
  if (record.code === true) {
    annotations.code = true;
  }
  if (typeof record.color === "string" && record.color !== "default") {
    annotations.color = record.color;
  }

  return Object.keys(annotations).length > 0 ? annotations : undefined;
}

function normalizeColor(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  return value === "default" ? undefined : value;
}

function normalizeCalloutIcon(
  value: unknown,
):
  | { emoji: string; type: "emoji" }
  | { type: "external"; url: string }
  | { type: "file"; url: string }
  | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }

  const record = value as Record<string, unknown>;
  const type = typeof record.type === "string" ? record.type : null;
  if (!type) {
    return undefined;
  }
  if (type === "emoji") {
    const emoji = typeof record.emoji === "string" ? record.emoji : "";
    return emoji ? { emoji, type: "emoji" } : undefined;
  }
  if (type === "external") {
    const external = record.external as Record<string, unknown> | undefined;
    const url = external && typeof external.url === "string" ? external.url : "";
    return url ? { type: "external", url } : undefined;
  }
  if (type === "file") {
    const file = record.file as Record<string, unknown> | undefined;
    const url = file && typeof file.url === "string" ? file.url : "";
    return url ? { type: "file", url } : undefined;
  }
  return undefined;
}

function toCalloutIconRequest(value: unknown): CalloutIconRequest | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }

  const record = value as Record<string, unknown>;
  const type = typeof record.type === "string" ? record.type : null;
  if (!type) {
    return undefined;
  }
  if (type === "emoji") {
    const emoji = typeof record.emoji === "string" ? record.emoji : "";
    return emoji ? { emoji, type: "emoji" } : undefined;
  }
  if (type === "external") {
    const external = record.external as Record<string, unknown> | undefined;
    const url = external && typeof external.url === "string" ? external.url : "";
    return url ? { external: { url }, type: "external" } : undefined;
  }
  return undefined;
}

function extractImageUrl(record: Record<string, unknown>): string | null {
  const imageType = typeof record.type === "string" ? record.type : null;
  if (imageType === "external") {
    const external = record.external as { url?: unknown } | undefined;
    return typeof external?.url === "string" ? external.url : null;
  }
  if (imageType === "file") {
    const file = record.file as { url?: unknown } | undefined;
    return typeof file?.url === "string" ? file.url : null;
  }
  if (imageType === "file_upload") {
    const fileUpload = record.file_upload as { id?: unknown } | undefined;
    return typeof fileUpload?.id === "string" ? fileUpload.id : null;
  }
  return null;
}

function chunkArray<T>(items: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let index = 0; index < items.length; index += size) {
    chunks.push(items.slice(index, index + size));
  }
  return chunks;
}

function toNotionBlockRequests(blocks: NotionBlock[]): AppendChildren {
  return blocks as AppendChildren;
}
