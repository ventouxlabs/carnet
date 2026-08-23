// Copyright (C) 2025 Ventoux Labs
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from "vitest";

import { rewriteImageEmbedsToAssetUrls } from "./karakeepInlineImages";

describe("rewriteImageEmbedsToAssetUrls", () => {
  it("rewrites a Photos embed to its mapped asset URL", () => {
    const body = "# T\n\n![](../Photos/a.jpg)\n\nbody\n";
    const map = new Map([["../Photos/a.jpg", "/api/assets/as_1"]]);
    expect(rewriteImageEmbedsToAssetUrls(body, map)).toBe(
      "# T\n\n![](/api/assets/as_1)\n\nbody\n",
    );
  });

  it("preserves alt text and a caption title", () => {
    const body = '![the cat](../Photos/cat.jpg "my cat")';
    const map = new Map([["../Photos/cat.jpg", "/api/assets/as_9"]]);
    expect(rewriteImageEmbedsToAssetUrls(body, map)).toBe(
      '![the cat](/api/assets/as_9 "my cat")',
    );
  });

  it("rewrites multiple embeds, each to its own asset URL", () => {
    const body = "![](../Photos/a.jpg)\n\n![](../Photos/b.jpg)";
    const map = new Map([
      ["../Photos/a.jpg", "/api/assets/as_1"],
      ["../Photos/b.jpg", "/api/assets/as_2"],
    ]);
    expect(rewriteImageEmbedsToAssetUrls(body, map)).toBe(
      "![](/api/assets/as_1)\n\n![](/api/assets/as_2)",
    );
  });

  it("leaves an embed whose rel is NOT in the map unchanged", () => {
    const body = "![](../Photos/a.jpg)\n\n![](../Photos/unmapped.jpg)";
    const map = new Map([["../Photos/a.jpg", "/api/assets/as_1"]]);
    expect(rewriteImageEmbedsToAssetUrls(body, map)).toBe(
      "![](/api/assets/as_1)\n\n![](../Photos/unmapped.jpg)",
    );
  });

  it("does not touch Files or Audio links", () => {
    const body = "[doc](../Files/x.pdf)\n\n[clip](../Audio/y.m4a)";
    const map = new Map([
      ["../Files/x.pdf", "/api/assets/as_1"],
      ["../Audio/y.m4a", "/api/assets/as_2"],
    ]);
    expect(rewriteImageEmbedsToAssetUrls(body, map)).toBe(body);
  });

  it("is idempotent once embeds are already rewritten (no ../Photos left)", () => {
    const body = "![](/api/assets/as_1)";
    const map = new Map([["../Photos/a.jpg", "/api/assets/as_1"]]);
    expect(rewriteImageEmbedsToAssetUrls(body, map)).toBe(body);
  });

  it("is a no-op with an empty map", () => {
    const body = "# T\n\n![](../Photos/a.jpg)\n";
    expect(rewriteImageEmbedsToAssetUrls(body, new Map())).toBe(body);
  });
});
