import { describe, expect, it } from "vitest";
import { buildSections, sectionKind } from "../src/lessons/sections.js";
import { blocksToMarkdown } from "../src/notion/markdown.js";
import { block, rt, sampleLessonBlocks, toggleH1 } from "./fixtures.js";

describe("buildSections", () => {
  const { sections, warnings } = buildSections("page-1", sampleLessonBlocks());
  const byTitle = (t: string) => sections.find((s) => s.title === t)!;

  it("splits on top-level heading_1 and keeps original titles in order", () => {
    expect(sections.map((s) => s.title)).toEqual([
      "Learning materials",
      "Warm-up",
      "Short Talk",
      "Vocabulary",
      "GROUP ACTIVITY",
      "Gramma",
    ]);
    expect(sections.map((s) => s.position)).toEqual([0, 1, 2, 3, 4, 5]);
    expect(warnings).toEqual([]);
  });

  it("maps known names (including typos) to kinds", () => {
    expect(sections.map((s) => s.kind)).toEqual([
      "learning-materials",
      "warm-up",
      "short-talk",
      "vocabulary",
      "group-activity",
      "grammar",
    ]);
    expect(sectionKind("Statement Debate")).toBe("debate");
    expect(sectionKind("Role Play")).toBe("other");
  });

  it("attaches stray top-level blocks to the preceding section", () => {
    expect(byTitle("GROUP ACTIVITY").sourceMarkdown).toBe("Describe the pictures.\nSPEAKING: What items are prohibited?");
  });

  it("drops template leftovers whose body only repeats the title", () => {
    expect(sections.find((s) => s.title === "Extended Learning")).toBeUndefined();
  });

  it("keeps a materials-only section and does not store hosted file URLs", () => {
    const materials = byTitle("Learning materials");
    expect(materials.resources).toEqual([
      { kind: "pdf", blockId: expect.any(String), name: "worksheet.pdf", url: undefined, hosted: true },
    ]);
    expect(materials.sourceMarkdown).not.toContain("s3.example.com");
  });

  it("renders nested lists as indented Markdown", () => {
    expect(byTitle("Vocabulary").sourceMarkdown).toBe(
      "- a) suitcase：行李箱\n1. ( a ) A bag for clothes.\n  - 答案：a) suitcase",
    );
  });

  it("puts content before the first heading into an Introduction section keyed by the page id", () => {
    const result = buildSections("page-1", [block("paragraph", "Hello"), toggleH1("Warm-up", [block("paragraph", "Hi")])]);
    expect(result.sections[0]).toMatchObject({ notionBlockId: "page-1", title: "Introduction", kind: "other" });
  });

  it("gives the same hash for the same content and a different one when it changes", () => {
    const again = buildSections("page-1", sampleLessonBlocks()).sections;
    expect(again.map((s) => s.sourceHash)).toEqual(sections.map((s) => s.sourceHash));
    const edited = sampleLessonBlocks();
    edited[1] = toggleH1("Warm-up", [block("paragraph", "Changed")]);
    expect(buildSections("page-1", edited).sections[1]!.sourceHash).not.toBe(sections[1]!.sourceHash);
  });
});

describe("blocksToMarkdown", () => {
  it("numbers consecutive list items and restarts after other blocks", () => {
    const { markdown } = blocksToMarkdown([
      block("numbered_list_item", "a"),
      block("numbered_list_item", "b"),
      block("paragraph", "x"),
      block("numbered_list_item", "c"),
    ]);
    expect(markdown).toBe("1. a\n2. b\nx\n1. c");
  });

  it("keeps only http(s) links and annotations", () => {
    const { markdown } = blocksToMarkdown([
      { id: "b1", type: "paragraph", paragraph: { rich_text: [
        { plain_text: "site", href: "https://example.com" },
        { plain_text: " bad", href: "javascript:alert(1)" },
        { plain_text: " bold", annotations: { bold: true } },
      ] } },
    ]);
    expect(markdown).toBe("[site](https://example.com) bad **bold**");
  });

  it("warns about unsupported blocks and embeds but keeps going", () => {
    const { markdown, warnings, resources } = blocksToMarkdown([
      { id: "u1", type: "unsupported", unsupported: {} },
      { id: "e1", type: "embed", embed: { url: "https://example.com/e" } },
      block("quote", "line1\nline2"),
    ]);
    expect(warnings).toHaveLength(2);
    expect(resources).toEqual([{ kind: "link", blockId: "e1", url: "https://example.com/e", hosted: false }]);
    expect(markdown).toBe("<https://example.com/e>\n> line1\n> line2");
  });

  it("flattens column layouts", () => {
    const { markdown } = blocksToMarkdown([
      { id: "c", type: "column_list", column_list: {}, children: [
        { id: "c1", type: "column", column: {}, children: [block("paragraph", "left")] },
        { id: "c2", type: "column", column: {}, children: [block("paragraph", "right")] },
      ] },
    ]);
    expect(markdown).toBe("left\nright");
  });

  it("renders table rows", () => {
    const table = { id: "t", type: "table", table: {}, children: [
      { id: "r1", type: "table_row", table_row: { cells: [rt("word"), rt("意思")] } },
    ] };
    expect(blocksToMarkdown([table]).markdown).toBe("| word | 意思 |");
  });
});
