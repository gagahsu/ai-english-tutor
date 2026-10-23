import {
  Client,
  collectPaginatedAPI,
  extractNotionId,
  isFullBlock,
  isFullPage,
  type PageObjectResponse,
} from "@notionhq/client";
import { fromNotionError } from "../errors.js";
import type { RawBlock } from "./markdown.js";

export interface LessonRow {
  pageId: string;
  title: string;
  lastEditedTime: string;
  archived: boolean;
}

/** The slice of the Notion API the app uses; tests substitute a fake. */
export interface NotionGateway {
  getDatabaseTitle(databaseId: string): Promise<string>;
  listLessonRows(databaseId: string): Promise<LessonRow[]>;
  getLessonRow(pageId: string): Promise<LessonRow>;
  getBlockTree(blockId: string): Promise<RawBlock[]>;
  /** Returns a fresh URL for a file/pdf/image block (Notion-hosted URLs expire after about an hour). */
  getFileUrl(blockId: string): Promise<string | null>;
}

// Notion allows an average of ~3 requests per second per integration.
const MIN_INTERVAL_MS = 350;

export function createNotionGateway(token: string): NotionGateway {
  const client = new Client({ auth: token, timeoutMs: 30_000 });
  let next = 0;
  async function call<T>(fn: () => Promise<T>): Promise<T> {
    const wait = next - Date.now();
    next = Math.max(next, Date.now()) + MIN_INTERVAL_MS;
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    try {
      return await fn();
    } catch (err) {
      throw fromNotionError(err);
    }
  }
  const listChildren = (blockId: string) =>
    call(() => collectPaginatedAPI(client.blocks.children.list, { block_id: blockId, page_size: 100 }));

  async function getBlockTree(blockId: string): Promise<RawBlock[]> {
    const blocks = (await listChildren(blockId)).filter(isFullBlock) as unknown as RawBlock[];
    for (const block of blocks) {
      if (block.has_children && block.type !== "child_page" && block.type !== "child_database") {
        block.children = await getBlockTree(block.id);
      }
    }
    return blocks;
  }

  return {
    async getDatabaseTitle(databaseId) {
      const db = await call(() => client.databases.retrieve({ database_id: normalizeId(databaseId) }));
      return "title" in db ? db.title.map((t) => t.plain_text).join("") : "";
    },
    async listLessonRows(databaseId) {
      const db = await call(() => client.databases.retrieve({ database_id: normalizeId(databaseId) }));
      const rows: LessonRow[] = [];
      for (const ds of "data_sources" in db ? db.data_sources : []) {
        const pages = await call(() => collectPaginatedAPI(client.dataSources.query, { data_source_id: ds.id }));
        rows.push(...pages.filter(isFullPage).map(toLessonRow));
      }
      return rows;
    },
    async getLessonRow(pageId) {
      const page = await call(() => client.pages.retrieve({ page_id: pageId }));
      if (!isFullPage(page)) throw fromNotionError(new Error("partial page"));
      return toLessonRow(page);
    },
    getBlockTree,
    async getFileUrl(blockId) {
      const block = await call(() => client.blocks.retrieve({ block_id: blockId }));
      if (!isFullBlock(block)) return null;
      const data = (block as unknown as Record<string, unknown>)[block.type] as
        | { type?: string; file?: { url: string }; external?: { url: string } }
        | undefined;
      return data?.file?.url ?? data?.external?.url ?? null;
    },
  };
}

function normalizeId(urlOrId: string): string {
  return extractNotionId(urlOrId) ?? urlOrId;
}

function toLessonRow(page: PageObjectResponse): LessonRow {
  const titleProp = Object.values(page.properties).find((p) => p.type === "title");
  const title = titleProp?.type === "title" ? titleProp.title.map((t) => t.plain_text).join("") : "";
  return {
    pageId: page.id,
    title,
    lastEditedTime: page.last_edited_time,
    archived: page.in_trash || page.archived,
  };
}
