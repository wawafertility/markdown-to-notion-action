import assert from "node:assert/strict";
import test from "node:test";

import {
  isNotionArchivedError,
  isNotionBlockArchivedError,
  isTransientNotionError,
  normalizeNotionId,
  notionPageUrl,
  toDashedId,
} from "../src/notion-api.js";

const PAGE_ID = "387aa331d0584c82ba09feaa972a7550";
const BLOCK_ID = "6ba23314f3084d8fbd9867b7286c9460";

test("normalizeNotionId extracts the block fragment before page and query ids", () => {
  const url = `https://www.notion.so/notion/sample-url-${PAGE_ID}#${BLOCK_ID}`;

  assert.equal(normalizeNotionId(url), BLOCK_ID);
});

test("normalizeNotionId extracts inline database ids before view ids", () => {
  const url =
    "https://app.notion.com/p/parcellab/3a3c37dcb4c480d2ac6df52801c367c3?v=3a3c37dcb4c480f1a72e000c76faf235&source=copy_link";

  assert.equal(normalizeNotionId(url), "3a3c37dcb4c480d2ac6df52801c367c3");
});

test("toDashedId normalizes compact ids for Notion API requests", () => {
  assert.equal(toDashedId(PAGE_ID), "387aa331-d058-4c82-ba09-feaa972a7550");
});

test("notionPageUrl builds a stable page URL from dashed or compact ids", () => {
  assert.equal(notionPageUrl(toDashedId(PAGE_ID)), `https://www.notion.so/${PAGE_ID}`);
});

test("normalizeNotionId rejects values without a Notion id", () => {
  assert.throws(() => normalizeNotionId("not-a-notion-id"), /Invalid Notion id/);
});

test("block archived errors stay distinct from page archived and transient errors", () => {
  const blockArchived = notionError(
    "Can't edit block that is archived. You must unarchive the block before editing.",
    "validation_error",
  );
  const pageArchived = notionError("Can't edit page that is archived.", "validation_error");
  const conflict = notionError(
    "Conflict occurred while saving. Please try again.",
    "conflict_error",
    409,
  );

  assert.equal(isNotionBlockArchivedError(blockArchived), true);
  assert.equal(isNotionArchivedError(blockArchived), true);
  assert.equal(isNotionBlockArchivedError(pageArchived), false);
  assert.equal(isNotionArchivedError(pageArchived), true);
  assert.equal(isTransientNotionError(conflict), true);
  assert.equal(isTransientNotionError(blockArchived), false);
  assert.equal(
    isTransientNotionError(notionError("unavailable", "service_unavailable", 503)),
    true,
  );
});

function notionError(message: string, code: string, status = 400): Error {
  return Object.assign(new Error(message), { code, status });
}
