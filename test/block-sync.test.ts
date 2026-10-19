import assert from "node:assert/strict";
import test from "node:test";

import type { Client } from "@notionhq/client";

import { syncPageBlocks } from "../src/block-sync.js";
import type { NotionBlock } from "../src/notion-types.js";

test("syncPageBlocks replaces an archived child block instead of failing the page", async () => {
  const appends: Array<{ after?: string; children: unknown[] }> = [];
  const notion = {
    blocks: {
      children: {
        append: async (request: { after?: string; children: unknown[] }) => {
          appends.push(request);
          if (request.after) {
            throw Object.assign(
              new Error(
                "Can't edit block that is archived. You must unarchive the block before editing.",
              ),
              { code: "validation_error", status: 400 },
            );
          }
          return { results: [{ id: "new-block" }] };
        },
        list: async () => ({
          has_more: false,
          next_cursor: null,
          results: [
            {
              has_children: false,
              id: "11111111-1111-1111-1111-111111111111",
              object: "block",
              paragraph: {
                rich_text: [{ plain_text: "old", text: { content: "old" }, type: "text" }],
              },
              type: "paragraph",
            },
          ],
        }),
      },
      delete: async () => {
        throw new Error(
          "delete should not run for an archived block that was not replaced in place",
        );
      },
      update: async () => {
        throw Object.assign(
          new Error(
            "Can't edit block that is archived. You must unarchive the block before editing.",
          ),
          { code: "validation_error", status: 400 },
        );
      },
    },
  } as unknown as Client;
  const incoming: NotionBlock[] = [
    {
      paragraph: { rich_text: [{ text: { content: "new" }, type: "text" }] },
      type: "paragraph",
    },
  ];
  const warnings: string[] = [];

  await syncPageBlocks(notion, "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", incoming, {
    info: () => {},
    warn: (message) => {
      warnings.push(message);
    },
  });

  assert.equal(appends.length, 1);
  assert.equal(appends[0]?.after, undefined);
  assert.match(warnings.join("\n"), /without recreating the page/);
});
