import { describe, expect, it } from "vitest";
import { attachmentDestination, pairedMarkdownLinks } from "./pairedMarkdownLinks";

describe("paired Markdown destinations", () => {
  it.each(["photo.jpg", "a photo.jpg", "a photo (1).jpg", "a ((nested)) photo.jpg"])("round-trips %s", (filename) => {
    const rel = `../Photos/${filename}`;
    expect(pairedMarkdownLinks(`![](${attachmentDestination(rel)})`)[0]).toMatchObject({ filename, rel, subdir: "Photos", image: true });
    expect(pairedMarkdownLinks(`![](${rel})`)[0]).toMatchObject({ filename, rel });
  });
  it.each(["../Photos/../secret", "../Files/..", "../Files/a/b.pdf", "../Files/a\\b.pdf", "https://example.com/a.pdf", "../Files/a.pdf\\ntext"])("rejects %s", (rel) => {
    expect(pairedMarkdownLinks(`[x](<${rel}>)`)).toEqual([]);
  });
  it.each([
    "`![](../Photos/example.jpg)`",
    "``![](../Photos/example.jpg)``",
    "```md\n![](../Photos/example.jpg)\n```",
    "~~~~\n![](../Photos/example.jpg)\n~~~~",
    "```\n![](../Photos/example.jpg)",
    "\\[example](../Files/example.pdf)",
  ])("does not discover links from code or escaped markup: %s", (body) => {
    expect(pairedMarkdownLinks(body)).toEqual([]);
  });
  it.each(["%2e%2e", "..%2fsecret", "..%5Csecret", "..%2f..%2fsecret%FF.pdf", "..%2fsecret%.pdf", "a%00%FF.pdf"])("rejects encoded traversal %s", (filename) => {
    expect(pairedMarkdownLinks(`[x](../Files/${filename})`)).toEqual([]);
  });
  it("rejects many unterminated destinations without partial matches", () => {
    expect(pairedMarkdownLinks("[".repeat(40000))).toEqual([]);
    const malformed = "[x](../Files/".repeat(4000);
    expect(pairedMarkdownLinks(malformed)).toEqual([]);
    expect(pairedMarkdownLinks("[x](<../Files/".repeat(4000))).toEqual([]);
  });
  it("retains plain filename bytes, percent signs and Unicode", () => {
    expect(attachmentDestination("../Files/a%20é.pdf")).toBe("../Files/a%20é.pdf");
    expect(pairedMarkdownLinks("[a%20é.pdf](../Files/a%20é.pdf)")[0].filename).toBe("a%20é.pdf");
  });
});
