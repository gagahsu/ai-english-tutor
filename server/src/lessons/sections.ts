import { createHash } from "node:crypto";
import { blocksToMarkdown, plainText, type RawBlock } from "../notion/markdown.js";
import type { Resource, SectionKind } from "./types.js";

export interface BuiltSection {
  /** The heading_1 block id, or the page id for content that precedes the first heading. */
  notionBlockId: string;
  position: number;
  kind: SectionKind;
  title: string;
  sourceMarkdown: string;
  sourceHash: string;
  resources: Resource[];
}

const KIND_BY_NAME: Record<string, SectionKind> = {
  learningmaterials: "learning-materials",
  warmup: "warm-up",
  shorttalk: "short-talk",
  vocabulary: "vocabulary",
  conversation: "conversation",
  reading: "reading",
  grammar: "grammar",
  gramma: "grammar",
  expression: "expression",
  expressions: "expression",
  sentencestructure: "sentence-structure",
  speaking: "speaking",
  discussion: "discussion",
  statementdebate: "debate",
  debate: "debate",
  groupactivity: "group-activity",
  extendedlearning: "extended-learning",
};

const normalize = (s: string) => s.toLowerCase().replace(/[^a-z0-9一-鿿]/g, "");

export function sectionKind(title: string): SectionKind {
  return KIND_BY_NAME[normalize(title)] ?? "other";
}

/**
 * Splits a lesson page into sections: each top-level heading_1 (usually a toggle heading)
 * starts a section; top-level blocks outside any toggle join the preceding section.
 * Empty sections, and template leftovers whose body only repeats the title, are dropped.
 */
export function buildSections(pageId: string, blocks: RawBlock[]): { sections: BuiltSection[]; warnings: string[] } {
  const groups: { id: string; title: string; body: RawBlock[] }[] = [];
  for (const block of blocks) {
    if (block.type === "heading_1") {
      const data = block.heading_1 as { rich_text?: unknown } | undefined;
      groups.push({ id: block.id, title: plainText(data?.rich_text).trim(), body: [...(block.children ?? [])] });
    } else {
      if (groups.length === 0) groups.push({ id: pageId, title: "Introduction", body: [] });
      groups[groups.length - 1]!.body.push(block);
    }
  }

  const sections: BuiltSection[] = [];
  const warnings: string[] = [];
  for (const group of groups) {
    const { markdown, resources, warnings: w } = blocksToMarkdown(group.body);
    warnings.push(...w.map((msg) => `${group.title}：${msg}`));
    const isEmpty = resources.length === 0 && (normalize(markdown) === "" || normalize(markdown) === normalize(group.title));
    if (isEmpty) continue;
    sections.push({
      notionBlockId: group.id,
      position: sections.length,
      kind: sectionKind(group.title),
      title: group.title,
      sourceMarkdown: markdown,
      sourceHash: createHash("sha256").update(`${group.title}\n${markdown}`).digest("hex"),
      resources,
    });
  }
  return { sections, warnings };
}
