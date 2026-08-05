import * as core from "@actions/core";
import { Client } from "@notionhq/client";
import { createHash } from "node:crypto";
import { load as loadYaml } from "js-yaml";
import * as fs from "node:fs/promises";
import path from "node:path";
import { markdownToNotionBlocks, extractTitle } from "./markdown-to-notion.js";
import { uploadImageBlocks } from "./image-uploads.js";
import { normalizeNotionId, notionPageUrl } from "./notion-api.js";
import { isInsidePath, resolveChildPath, resolveFromDirectory } from "./path-utils.js";
import type { LogContext } from "./logging.js";
import type { NotionBlock } from "./notion-types.js";
import type { MarkdownDocument, SyncStateEntry } from "./sync-types.js";

export async function ensureDirectoryExists(dirPath: string): Promise<void> {
  const stats = await fs.stat(dirPath);
  if (!stats.isDirectory()) {
    throw new Error(`${dirPath} is not a directory.`);
  }
}

export async function collectMarkdownFiles(
  dirPath: string,
  privateMarkdownPrefix: string | null,
  excludeGlobs: string[] = [],
  repositoryRoot: string = dirPath,
): Promise<string[]> {
  async function collectDirectory(currentPath: string): Promise<string[]> {
    const entries = await fs.readdir(currentPath, { withFileTypes: true });
    const files: string[] = [];
    for (const entry of entries) {
      const fullPath = resolveChildPath(currentPath, entry.name);
      const relativePaths = [dirPath, repositoryRoot].map((rootPath) => {
        const relativePath = normalizeDocumentPath(path.relative(rootPath, fullPath));
        return entry.isDirectory() ? `${relativePath}/` : relativePath;
      });
      if (
        excludeGlobs.some((pattern) =>
          relativePaths.some((relativePath) => path.matchesGlob(relativePath, pattern)),
        )
      ) {
        continue;
      }
      if (entry.isDirectory()) {
        if (entry.name === "node_modules" || entry.name.startsWith(".")) {
          continue;
        }
        files.push(...(await collectDirectory(fullPath)));
        continue;
      }
      if (
        entry.isFile() &&
        entry.name.toLowerCase().endsWith(".md") &&
        !isPrivateMarkdownFile(entry.name, privateMarkdownPrefix)
      ) {
        files.push(fullPath);
      }
    }
    return files;
  }

  return collectDirectory(dirPath);
}

export function normalizeDocumentPath(relPath: string): string {
  return relPath.replaceAll("\\", "/");
}

function isPrivateMarkdownFile(fileName: string, privateMarkdownPrefix: string | null): boolean {
  if (!privateMarkdownPrefix) {
    return false;
  }
  return fileName.startsWith(privateMarkdownPrefix);
}

export async function loadMarkdownDocuments(
  markdownFiles: string[],
  docsRoot: string,
  syncStateEntries: Map<string, SyncStateEntry>,
): Promise<MarkdownDocument[]> {
  const documents: MarkdownDocument[] = [];
  for (const filePath of markdownFiles) {
    const markdownContent = await fs.readFile(filePath, "utf8");
    const parsedFrontMatter = parseFrontMatter(markdownContent);
    const frontMatterAttributes = parsedFrontMatter.attributes;
    const markdownBody = parsedFrontMatter.body;

    const relPath = normalizeDocumentPath(path.relative(docsRoot, filePath));
    let notionPageId: string | undefined;
    const syncStateEntry = syncStateEntries.get(relPath);
    if (syncStateEntry?.pageId) {
      notionPageId = normalizeNotionId(syncStateEntry.pageId);
    } else if (
      typeof frontMatterAttributes.notion_page_id === "string" &&
      frontMatterAttributes.notion_page_id.trim().length > 0
    ) {
      try {
        notionPageId = normalizeNotionId(frontMatterAttributes.notion_page_id);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        core.warning(`Invalid notion_page_id in ${filePath}: ${message}`);
      }
    }

    const title = extractTitle(markdownBody) || path.basename(filePath, ".md");
    documents.push({
      absPath: filePath,
      attributes: frontMatterAttributes,
      body: markdownBody,
      relPath,
      sourceHash: hashMarkdownBody(markdownBody),
      title,
      notionPageId,
      notionUrl: notionPageId ? notionPageUrl(notionPageId) : undefined,
    });
  }
  return documents;
}

export async function buildBlocksForDocument(
  notion: Client,
  documentEntry: MarkdownDocument,
  docsFolderPath: string,
  workspaceRoot: string,
  knownPageUrls: Map<string, string>,
  githubToken: string | null,
  logContext: LogContext,
): Promise<NotionBlock[]> {
  const markdownBody = expandObsidianWikilinks(documentEntry.body);
  const blocks = markdownToNotionBlocks(markdownBody, {
    logger: (message) => logContext.info(message),
    resolveLink: (href) =>
      resolveRelativeLink(
        href,
        documentEntry.absPath,
        docsFolderPath,
        workspaceRoot,
        knownPageUrls,
      ),
  });
  await uploadImageBlocks(notion, blocks, githubToken, logContext);
  return blocks;
}

export function buildNotionPageTitle(documentEntry: MarkdownDocument, separator: string): string {
  const baseTitle = documentEntry.title || "Untitled";
  const folderPath = normalizeFolderPath(documentEntry.relPath);
  if (!folderPath) {
    return baseTitle;
  }

  const normalizedSeparator = separator.trim();
  const separatorText = normalizedSeparator ? ` ${normalizedSeparator} ` : " ";
  return `${folderPath.split("/").join(separatorText)}${separatorText}${baseTitle}`;
}

function normalizeFolderPath(relPath: string): string {
  const normalized = relPath.replaceAll("\\", "/");
  const dir = path.posix.dirname(normalized);
  if (dir === "." || dir === "/") {
    return "";
  }
  return dir.replace(/^\/+/, "");
}

function resolveRelativeLink(
  href: string,
  currentFilePath: string,
  docsRoot: string,
  workspaceRoot: string,
  knownPageUrls: Map<string, string>,
): string | null {
  const cleaned = href.split("#", 1)[0].split("?", 1)[0];
  if (!cleaned) {
    return null;
  }

  let resolvedPath: string;
  try {
    resolvedPath = resolveFromDirectory(path.dirname(currentFilePath), cleaned);
  } catch {
    return null;
  }
  if (!isInsidePath(docsRoot, resolvedPath)) {
    return null;
  }

  if (!isInsidePath(workspaceRoot, resolvedPath)) {
    return null;
  }

  const extension = path.extname(resolvedPath).toLowerCase();
  if (extension === ".md") {
    return knownPageUrls.get(resolvedPath) || buildGitHubBlobUrl(resolvedPath, workspaceRoot);
  }

  const repoRelativePath = path.relative(workspaceRoot, resolvedPath);
  // Images still use raw URLs so the existing Notion file-upload pipeline can fetch them.
  if (isUploadableImageExtension(extension)) {
    return buildGitHubRawUrl(repoRelativePath);
  }

  // PDFs and other binaries: blob URLs work for GitHub users with repo access.
  // raw.githubusercontent.com 404s on private repositories.
  return buildGitHubBlobUrl(resolvedPath, workspaceRoot);
}

function isUploadableImageExtension(extension: string): boolean {
  return [".png", ".jpg", ".jpeg", ".gif", ".svg", ".webp"].includes(extension);
}

function buildGitHubRawUrl(repoRelativePath: string): string | null {
  const ownerRepo = process.env.GITHUB_REPOSITORY;
  if (!ownerRepo) {
    return null;
  }

  const reference = process.env.GITHUB_SHA || process.env.GITHUB_REF_NAME;
  if (!reference) {
    return null;
  }

  const normalizedPath = repoRelativePath.split(path.sep).join("/");
  const serverUrl = (process.env.GITHUB_SERVER_URL || "https://github.com").replace(/\/+$/, "");
  if (serverUrl === "https://github.com") {
    return `https://raw.githubusercontent.com/${ownerRepo}/${reference}/${normalizedPath}`;
  }
  return `${serverUrl}/raw/${ownerRepo}/${reference}/${normalizedPath}`;
}

function buildGitHubBlobUrl(absolutePath: string, workspaceRoot: string): string | null {
  const ownerRepo = process.env.GITHUB_REPOSITORY;
  if (!ownerRepo) {
    return null;
  }

  const reference = process.env.GITHUB_SHA || process.env.GITHUB_REF_NAME;
  if (!reference) {
    return null;
  }

  const repoRelativePath = normalizeDocumentPath(path.relative(workspaceRoot, absolutePath));
  const serverUrl = (process.env.GITHUB_SERVER_URL || "https://github.com").replace(/\/+$/, "");
  return `${serverUrl}/${ownerRepo}/blob/${reference}/${repoRelativePath}`;
}

/**
 * Bump when rendered Notion output changes without the markdown source changing
 * (for example link resolution). Forces a re-sync of unchanged files.
 */
const CONTENT_RENDER_VERSION = "2";

function hashMarkdownBody(markdownBody: string): string {
  return createHash("sha256")
    .update(CONTENT_RENDER_VERSION, "utf8")
    .update("\0", "utf8")
    .update(markdownBody, "utf8")
    .digest("hex");
}

/**
 * Convert Obsidian-style wikilinks into standard markdown links so they can be
 * resolved to synced Notion pages (or GitHub blob URLs as a fallback).
 *
 * [[technical-reference]] -> [technical-reference](technical-reference.md)
 * [[Home|Vault home]] -> [Vault home](Home.md)
 * [[path/to/note]] -> [path/to/note](path/to/note.md)
 */
export function expandObsidianWikilinks(markdown: string): string {
  return markdown.replace(/\[\[([^\]]+)\]\]/g, (match, rawTarget: string) => {
    const [targetPart, aliasPart] = rawTarget.split("|", 2);
    const target = targetPart?.trim();
    if (!target || target.startsWith("#") || target.includes("://")) {
      return match;
    }

    const alias = aliasPart?.trim() || target;
    const withoutAnchor = target.split("#", 1)[0] || target;
    const href = withoutAnchor.toLowerCase().endsWith(".md")
      ? withoutAnchor
      : `${withoutAnchor}.md`;
    return `[${alias}](${href})`;
  });
}

function parseFrontMatter(markdownContent: string): {
  attributes: Record<string, unknown>;
  body: string;
} {
  const lines = markdownContent.split(/\r?\n/);
  if (lines[0] !== "---") {
    return { attributes: {}, body: markdownContent };
  }

  const endIndex = lines.indexOf("---", 1);
  if (endIndex === -1) {
    return { attributes: {}, body: markdownContent };
  }

  const yamlContent = lines.slice(1, endIndex).join("\n");
  const body = lines.slice(endIndex + 1).join("\n");
  try {
    const parsedYaml = loadYaml(yamlContent);
    const attributes = isRecord(parsedYaml) ? parsedYaml : {};
    return { attributes, body };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    core.warning(`Ignoring invalid YAML frontmatter: ${message}`);
    return { attributes: {}, body };
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
