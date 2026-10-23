import type { Resource } from "../lessons/types.js";

/**
 * A Notion block as returned by the API, with `children` filled in by the gateway.
 * Kept loose on purpose: the converter reads only the fields it understands and
 * reports everything else as a warning.
 */
export interface RawBlock {
  id: string;
  type: string;
  has_children?: boolean;
  children?: RawBlock[];
  [payload: string]: unknown;
}

interface RichText {
  plain_text: string;
  href?: string | null;
  annotations?: { bold?: boolean; italic?: boolean; code?: boolean };
}

interface RenderContext {
  resources: Resource[];
  warnings: string[];
}

const MEDIA_KINDS: Record<string, Resource["kind"]> = {
  pdf: "pdf",
  file: "file",
  image: "image",
  video: "video",
  audio: "audio",
};
// Containers whose children belong at the same level as the container itself.
const TRANSPARENT = new Set(["column_list", "column", "synced_block", "table"]);

const isHttpUrl = (url: string) => /^https?:\/\//i.test(url);

export function richTextToMarkdown(items: unknown): string {
  if (!Array.isArray(items)) return "";
  return (items as RichText[])
    .map((t) => {
      const raw = t.plain_text ?? "";
      // Markers must hug the text ("**word**", not "** word**"), so keep surrounding spaces outside.
      const [, lead, core, trail] = /^(\s*)(.*?)(\s*)$/s.exec(raw)!;
      if (!core) return raw;
      let text = core;
      const a = t.annotations ?? {};
      if (a.code) text = `\`${text}\``;
      if (a.bold) text = `**${text}**`;
      if (a.italic) text = `*${text}*`;
      if (t.href && isHttpUrl(t.href)) text = `[${text}](${t.href})`;
      return lead + text + trail;
    })
    .join("");
}

export function plainText(items: unknown): string {
  return Array.isArray(items) ? (items as RichText[]).map((t) => t.plain_text ?? "").join("") : "";
}

/** Converts a block list to Markdown, collecting media/link resources and warnings for unsupported blocks. */
export function blocksToMarkdown(blocks: RawBlock[]): { markdown: string; resources: Resource[]; warnings: string[] } {
  const ctx: RenderContext = { resources: [], warnings: [] };
  const lines = renderBlocks(blocks, 0, ctx);
  const markdown = lines
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return { markdown, resources: ctx.resources, warnings: ctx.warnings };
}

function renderBlocks(blocks: RawBlock[], depth: number, ctx: RenderContext): string[] {
  const lines: string[] = [];
  let listNo = 0;
  for (const block of blocks) {
    listNo = block.type === "numbered_list_item" ? listNo + 1 : 0;
    if (TRANSPARENT.has(block.type)) {
      lines.push(...renderBlocks(block.children ?? [], depth, ctx));
      continue;
    }
    const indent = "  ".repeat(depth);
    for (const line of renderBlock(block, listNo, ctx)) lines.push(line ? indent + line : "");
    if (block.children?.length) lines.push(...renderBlocks(block.children, depth + 1, ctx));
  }
  return lines;
}

function renderBlock(block: RawBlock, listNo: number, ctx: RenderContext): string[] {
  const data = (block[block.type] ?? {}) as Record<string, unknown>;
  const text = richTextToMarkdown(data.rich_text);
  const heading = /^heading_(\d)$/.exec(block.type);
  if (heading) return ["", `${"#".repeat(Number(heading[1]))} ${text}`];

  switch (block.type) {
    case "paragraph":
      return [text];
    case "bulleted_list_item":
    case "toggle":
      return [`- ${text}`];
    case "numbered_list_item":
      return [`${listNo}. ${text}`];
    case "to_do":
      return [`- [${data.checked ? "x" : " "}] ${text}`];
    case "quote":
    case "callout":
      return text.split("\n").map((l) => `> ${l}`);
    case "code":
      return ["```" + String(data.language ?? ""), plainText(data.rich_text), "```"];
    case "equation":
      return [`$$${String(data.expression ?? "")}$$`];
    case "divider":
      return ["---"];
    case "table_row": {
      const cells = Array.isArray(data.cells) ? data.cells.map((c) => richTextToMarkdown(c)) : [];
      return [`| ${cells.join(" | ")} |`];
    }
    case "bookmark":
    case "link_preview":
    case "embed": {
      const url = String(data.url ?? "");
      if (!isHttpUrl(url)) return [];
      ctx.resources.push({ kind: "link", blockId: block.id, url, hosted: false });
      if (block.type === "embed") ctx.warnings.push(`嵌入內容無法讀取，只保留連結：${url}`);
      return [`<${url}>`];
    }
    case "child_page":
    case "child_database":
      ctx.warnings.push(`子頁面「${String(data.title ?? "")}」不會同步內容。`);
      return [`[子頁面：${String(data.title ?? "")}]`];
  }

  const mediaKind = MEDIA_KINDS[block.type];
  if (mediaKind) {
    const external = data.type === "external";
    const url = external ? String((data.external as { url?: string } | undefined)?.url ?? "") : undefined;
    const name = String(data.name ?? "") || plainText(data.caption) || undefined;
    if (external && !isHttpUrl(url!)) return [];
    ctx.resources.push({ kind: mediaKind, blockId: block.id, name, url, hosted: !external });
    return [`[${mediaKind.toUpperCase()}${name ? `：${name}` : ""}]`];
  }

  ctx.warnings.push(`略過不支援的區塊類型：${block.type}`);
  return [];
}
