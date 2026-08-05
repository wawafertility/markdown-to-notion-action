import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import {
  buildNotionPageTitle,
  collectMarkdownFiles,
  loadMarkdownDocuments,
  normalizeDocumentPath,
} from "../src/documents.js";
import type { MarkdownDocument, SyncStateEntry } from "../src/sync-types.js";

const TEST_ROOT = path.join(process.cwd(), "tmp", "test-documents");
const NOTION_PAGE_ID = "387aa331d0584c82ba09feaa972a7550";

test("collectMarkdownFiles skips private files, ignored folders, and excluded globs", async () => {
  await resetTestRoot();
  await writeFixture("docs/public.md", "# Public");
  await writeFixture("docs/_private.md", "# Private");
  await writeFixture("docs/.hidden/hidden.md", "# Hidden");
  await writeFixture("docs/node_modules/package/readme.md", "# Dependency");
  await writeFixture("docs/nested/guide.MD", "# Nested");
  await writeFixture("docs/drafts/guide.md", "# Draft");
  await writeFixture("docs/nested/internal/secret.md", "# Secret");
  await writeFixture("docs/nested/old.draft.md", "# Old draft");

  const files = await collectMarkdownFiles(
    path.join(TEST_ROOT, "docs"),
    "_",
    ["docs/drafts/**", "nested/internal/**", "**/*.draft.md"],
    TEST_ROOT,
  );
  const relativeFiles = files
    .map((file) => normalizeDocumentPath(path.relative(TEST_ROOT, file)))
    .sort((firstPath, secondPath) => firstPath.localeCompare(secondPath));

  assert.deepEqual(relativeFiles, ["docs/nested/guide.MD", "docs/public.md"]);
});

test("loadMarkdownDocuments prefers sync state ids and hashes markdown body only", async () => {
  await resetTestRoot();
  const docsRoot = path.join(TEST_ROOT, "docs");
  const filePath = await writeFixture(
    "docs/api.md",
    `---\nnotion_page_id: ${NOTION_PAGE_ID}\n---\n# API Guide\n\nBody`,
  );
  const syncEntries = new Map<string, SyncStateEntry>([
    ["api.md", { pageId: "6ba23314f3084d8fbd9867b7286c9460", title: "Old" }],
  ]);

  const [documentEntry] = await loadMarkdownDocuments([filePath], docsRoot, syncEntries);

  assert.equal(documentEntry.relPath, "api.md");
  assert.equal(documentEntry.title, "API Guide");
  assert.equal(documentEntry.notionPageId, "6ba23314f3084d8fbd9867b7286c9460");
  assert.equal(documentEntry.sourceHash, hashWithRenderVersion("# API Guide\n\nBody"));
});

test("buildNotionPageTitle prefixes nested document folders", () => {
  const documentEntry = {
    relPath: "integrations/payments/adyen.md",
    title: "Adyen Setup",
  } as MarkdownDocument;

  assert.equal(buildNotionPageTitle(documentEntry, "→"), "integrations → payments → Adyen Setup");
});

test("expandObsidianWikilinks converts wiki targets into markdown links", async () => {
  const { expandObsidianWikilinks } = await import("../src/documents.js");

  assert.equal(
    expandObsidianWikilinks("See [[technical-reference]] and [[Home|Vault home]]."),
    "See [technical-reference](technical-reference.md) and [Vault home](Home.md).",
  );
  assert.equal(
    expandObsidianWikilinks("Leave [[#heading]] and [[https://example.com]] alone."),
    "Leave [[#heading]] and [[https://example.com]] alone.",
  );
});

test("loadMarkdownDocuments ignores invalid YAML frontmatter and still hashes the body", async () => {
  await resetTestRoot();
  const docsRoot = path.join(TEST_ROOT, "docs");
  const filePath = await writeFixture(
    "docs/broken-frontmatter.md",
    `---\naliases: [One, *** Broken, Two]\n---\n# Broken Frontmatter\n\nBody`,
  );

  const [documentEntry] = await loadMarkdownDocuments([filePath], docsRoot, new Map());

  assert.equal(documentEntry.relPath, "broken-frontmatter.md");
  assert.equal(documentEntry.title, "Broken Frontmatter");
  assert.deepEqual(documentEntry.attributes, {});
  assert.equal(documentEntry.sourceHash, hashWithRenderVersion("# Broken Frontmatter\n\nBody"));
});

async function resetTestRoot(): Promise<void> {
  await rm(TEST_ROOT, { force: true, recursive: true });
  await mkdir(TEST_ROOT, { recursive: true });
}

async function writeFixture(relativePath: string, content: string): Promise<string> {
  const filePath = path.join(TEST_ROOT, relativePath);
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, content);
  return filePath;
}

function hashWithRenderVersion(content: string): string {
  return createHash("sha256").update("2\0", "utf8").update(content, "utf8").digest("hex");
}
