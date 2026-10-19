import assert from "node:assert/strict";
import test from "node:test";

import type { Client } from "@notionhq/client";

import { updateNotionPageWithRecovery } from "../src/page-sync.js";

const PAGE_ID = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

test("updateNotionPageWithRecovery leaves a successful update unchanged", async () => {
  const notion = pageClient(async () => {
    throw new Error("page lookup should not run");
  });
  let updates = 0;

  const result = await updateNotionPageWithRecovery(notion, PAGE_ID, "API", silentLog, async () => {
    updates += 1;
  });

  assert.equal(result, "updated");
  assert.equal(updates, 1);
});

test("updateNotionPageWithRecovery retries a block archived error when the page is live", async () => {
  let reads = 0;
  const notion = pageClient(async () => {
    reads += 1;
    return { archived: false, in_trash: false };
  });
  let updates = 0;

  const result = await updateNotionPageWithRecovery(notion, PAGE_ID, "API", silentLog, async () => {
    updates += 1;
    if (updates === 1) {
      throw blockArchivedError();
    }
  });

  assert.equal(result, "updated");
  assert.equal(updates, 2);
  assert.equal(reads, 1);
});

test("updateNotionPageWithRecovery surfaces a repeated block archived error", async () => {
  const notion = pageClient(async () => ({ archived: false, in_trash: false }));
  let updates = 0;

  await assert.rejects(
    () =>
      updateNotionPageWithRecovery(notion, PAGE_ID, "API", silentLog, async () => {
        updates += 1;
        throw blockArchivedError();
      }),
    /Can't edit block that is archived/,
  );
  assert.equal(updates, 2);
});

test("updateNotionPageWithRecovery recreates only when the page itself is gone", async () => {
  const archivedPage = pageClient(async () => ({ archived: true, in_trash: false }));
  const missingPage = pageClient(async () => {
    throw Object.assign(new Error("Could not find page"), {
      code: "object_not_found",
      status: 404,
    });
  });
  let archivedUpdates = 0;
  let missingUpdates = 0;

  assert.equal(
    await updateNotionPageWithRecovery(archivedPage, PAGE_ID, "API", silentLog, async () => {
      archivedUpdates += 1;
      throw blockArchivedError();
    }),
    "recreate",
  );
  assert.equal(
    await updateNotionPageWithRecovery(missingPage, PAGE_ID, "API", silentLog, async () => {
      missingUpdates += 1;
      throw blockArchivedError();
    }),
    "recreate",
  );
  assert.equal(archivedUpdates, 1);
  assert.equal(missingUpdates, 1);
});

test("updateNotionPageWithRecovery does not recreate a live page after a content validation error", async () => {
  const notion = pageClient(async () => ({ archived: false, in_trash: false }));
  let updates = 0;

  await assert.rejects(
    () =>
      updateNotionPageWithRecovery(notion, PAGE_ID, "API", silentLog, async () => {
        updates += 1;
        throw Object.assign(new Error("body failed validation"), {
          code: "validation_error",
          status: 400,
        });
      }),
    /body failed validation/,
  );
  assert.equal(updates, 1);
});

test("updateNotionPageWithRecovery retries a transient conflict when the page is live", async () => {
  const notion = pageClient(async () => ({ archived: false, in_trash: false }));
  let updates = 0;

  const result = await updateNotionPageWithRecovery(notion, PAGE_ID, "API", silentLog, async () => {
    updates += 1;
    if (updates === 1) {
      throw Object.assign(new Error("Conflict occurred while saving."), {
        code: "conflict_error",
        status: 409,
      });
    }
  });

  assert.equal(result, "updated");
  assert.equal(updates, 2);
});

const silentLog = {
  info: () => {},
  warn: () => {},
};

function blockArchivedError(): Error {
  return Object.assign(
    new Error("Can't edit block that is archived. You must unarchive the block before editing."),
    { code: "validation_error", status: 400 },
  );
}

function pageClient(retrieve: () => Promise<unknown>): Client {
  return {
    pages: {
      retrieve,
    },
  } as unknown as Client;
}
