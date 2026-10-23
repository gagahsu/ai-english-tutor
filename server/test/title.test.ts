import { describe, expect, it } from "vitest";
import { parseLessonTitle } from "../src/lessons/title.js";

describe("parseLessonTitle", () => {
  it("parses titles with a leading space and no space before the series", () => {
    expect(parseLessonTitle(" A2 基礎會話c 3/10")).toEqual({
      title: "A2 基礎會話c 3/10",
      level: "A2",
      course: "基礎會話",
      series: "c",
      unit: 3,
      totalUnits: 10,
    });
  });

  it("accepts a spaced series and spacing around the slash", () => {
    expect(parseLessonTitle("A2 基礎會話 b 10 / 10")).toMatchObject({ course: "基礎會話", series: "b", unit: 10 });
  });

  it("does not take the last letter of an English course name as the series", () => {
    expect(parseLessonTitle("B1 Business English 2/8")).toMatchObject({ course: "Business English", series: null });
    expect(parseLessonTitle("B1 Business English d 2/8")).toMatchObject({ course: "Business English", series: "d" });
  });

  it.each(["Template", "", "A2 基礎會話c", "A2 基礎會話c 11/10", "A2 3/10"])("rejects %j", (title) => {
    expect(parseLessonTitle(title)).toBeNull();
  });
});
