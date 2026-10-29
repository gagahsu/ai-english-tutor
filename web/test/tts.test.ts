import { describe, expect, it } from "vitest";
import { App, parseRoute } from "../src/App";
import { safeUrl } from "../src/safeUrl";
import { chunks, speakableEnglish } from "../src/voice/tts";

describe("TTS text", () => {
  it("never reads Chinese aloud", () => {
    expect(speakableEnglish("You can say: I loved Okinawa（沖繩）. 很好！Can you try?")).toBe("You can say: I loved Okinawa . Can you try?");
  });

  it("splits long replies into sentence chunks", () => {
    const long = Array.from({ length: 6 }, (_, i) => `This is sentence number ${i + 1} of a long reply.`).join(" ");
    const parts = chunks(long);
    expect(parts.length).toBeGreaterThan(1);
    expect(parts.every((p) => p.length <= 180)).toBe(true);
    expect(parts.join(" ")).toBe(long);
  });
});

describe("links and routes", () => {
  it("allows only http(s) and the resource proxy", () => {
    expect(safeUrl("https://example.com/a.pdf")).toBe("https://example.com/a.pdf");
    expect(safeUrl("/api/resources/abc")).toBe("/api/resources/abc");
    expect(safeUrl("javascript:alert(1)")).toBeNull();
    expect(safeUrl("data:text/html,x")).toBeNull();
    expect(safeUrl(undefined)).toBeNull();
  });

  it("parses hash routes", () => {
    expect(parseRoute("#/lessons/abc%20d")).toEqual({ page: "classroom", lessonId: "abc d" });
    expect(parseRoute("#/settings")).toEqual({ page: "settings" });
    expect(parseRoute("")).toEqual({ page: "lessons" });
    expect(App).toBeTypeOf("function");
  });
});
