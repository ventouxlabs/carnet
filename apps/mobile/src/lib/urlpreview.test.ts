import { beforeEach, describe, expect, it, vi } from "vitest";

const fetchMock = vi.fn();
globalThis.fetch = fetchMock as unknown as typeof fetch;

import { __ssrfGuardInternals, fetchUrlPreview } from "./urlpreview";

const { extractHost, isBlockedHost } = __ssrfGuardInternals;

function htmlResponse(body: string, status = 200): Response {
  return new Response(body, {
    status,
    headers: { "Content-Type": "text/html; charset=utf-8" },
  });
}

beforeEach(() => {
  fetchMock.mockReset();
});

describe("fetchUrlPreview", () => {
  it("extracts og:* fields and returns structured preview", async () => {
    const html = `
      <html><head>
        <title>Fallback Title</title>
        <meta property="og:title" content="A Real Article">
        <meta property="og:description" content="The summary of the article.">
        <meta property="og:site_name" content="Example News">
      </head><body><p>First paragraph.</p></body></html>
    `;
    fetchMock.mockResolvedValueOnce(htmlResponse(html));

    const result = await fetchUrlPreview("https://example.com/article");

    expect(result).not.toBeNull();
    expect(result!.title).toBe("A Real Article");
    expect(result!.description).toBe("The summary of the article.");
    expect(result!.siteName).toBe("Example News");
    expect(result!.contentType).toMatch(/text\/html/);
  });

  it("falls through to <title> and meta description when og:* missing", async () => {
    const html = `
      <html><head>
        <title>Plain Title</title>
        <meta name="description" content="Plain description.">
      </head></html>
    `;
    fetchMock.mockResolvedValueOnce(htmlResponse(html));

    const result = await fetchUrlPreview("https://example.com/plain");

    expect(result).not.toBeNull();
    expect(result!.title).toBe("Plain Title");
    expect(result!.description).toBe("Plain description.");
    expect(result!.siteName).toBe("example.com");
  });

  it("decodes HTML entities in extracted fields", async () => {
    const html = `
      <html><head>
        <title>Q&amp;A: What&#39;s next?</title>
        <meta name="description" content="Costs &lt; 5 &amp; rising">
      </head></html>
    `;
    fetchMock.mockResolvedValueOnce(htmlResponse(html));

    const result = await fetchUrlPreview("https://example.com/x");

    expect(result!.title).toBe("Q&A: What's next?");
    expect(result!.description).toBe("Costs < 5 & rising");
  });

  it("truncates very large bodies but still extracts from the <head>", async () => {
    // 300 KB of trailing junk — title sits in the first KB.
    const junk = "<div>x</div>".repeat(40_000);
    const html = `<html><head><title>Buried Title</title></head><body>${junk}</body></html>`;
    fetchMock.mockResolvedValueOnce(htmlResponse(html));

    const result = await fetchUrlPreview("https://example.com/big");

    expect(result!.title).toBe("Buried Title");
  });

  it("returns null on non-200 response", async () => {
    fetchMock.mockResolvedValueOnce(htmlResponse("<html></html>", 404));
    expect(await fetchUrlPreview("https://example.com/missing")).toBeNull();
  });

  it("returns null on non-HTML content-type", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response('{"k":"v"}', {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
    expect(await fetchUrlPreview("https://example.com/api")).toBeNull();
  });

  it("returns null when fetch rejects (network error)", async () => {
    fetchMock.mockRejectedValueOnce(new Error("ECONNREFUSED"));
    expect(await fetchUrlPreview("https://example.com/offline")).toBeNull();
  });

  it("returns null on AbortError (timeout)", async () => {
    fetchMock.mockRejectedValueOnce(
      Object.assign(new Error("aborted"), { name: "AbortError" }),
    );
    expect(await fetchUrlPreview("https://example.com/slow")).toBeNull();
  });

  it("returns null for invalid URL without fetching", async () => {
    expect(await fetchUrlPreview("not a url")).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("returns null for non-http(s) schemes without fetching", async () => {
    expect(await fetchUrlPreview("file:///etc/passwd")).toBeNull();
    expect(await fetchUrlPreview("javascript:alert(1)")).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("returns null when both title and description are absent", async () => {
    fetchMock.mockResolvedValueOnce(
      htmlResponse("<html><head></head><body></body></html>"),
    );
    expect(await fetchUrlPreview("https://example.com/empty")).toBeNull();
  });

  it("uses first <p> as description fallback", async () => {
    const html = `
      <html><head><title>Only Title</title></head>
      <body><p>The opening <strong>paragraph</strong> here.</p></body></html>
    `;
    fetchMock.mockResolvedValueOnce(htmlResponse(html));

    const result = await fetchUrlPreview("https://example.com/p");

    expect(result!.title).toBe("Only Title");
    expect(result!.description).toBe("The opening paragraph here.");
  });

  it("sends a Mozilla-compatible User-Agent", async () => {
    fetchMock.mockResolvedValueOnce(
      htmlResponse("<html><head><title>X</title></head></html>"),
    );
    await fetchUrlPreview("https://example.com/ua");
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const ua = (init.headers as Record<string, string>)["User-Agent"];
    expect(ua).toMatch(/Mozilla/);
    expect(ua).toMatch(/carnet/);
  });

  it("handles meta tags with content-first attribute order", async () => {
    const html = `
      <html><head>
        <meta content="Reordered Title" property="og:title">
        <meta content="Reordered Desc" name="description">
      </head></html>
    `;
    fetchMock.mockResolvedValueOnce(htmlResponse(html));

    const result = await fetchUrlPreview("https://example.com/order");

    expect(result!.title).toBe("Reordered Title");
    expect(result!.description).toBe("Reordered Desc");
  });

  it("trims fields longer than 500 characters", async () => {
    const long = "A".repeat(1000);
    const html = `<html><head><meta property="og:title" content="${long}"><title>x</title></head></html>`;
    fetchMock.mockResolvedValueOnce(htmlResponse(html));

    const result = await fetchUrlPreview("https://example.com/long");

    expect(result!.title.length).toBeLessThanOrEqual(500);
  });

  it("does not throw on numeric entities above U+10FFFF", async () => {
    // &#1114112; is exactly one beyond the max code point —
    // String.fromCodePoint would throw RangeError without the guard.
    const html = `<html><head><title>safe &#1114112; title</title></head></html>`;
    fetchMock.mockResolvedValueOnce(htmlResponse(html));

    const result = await fetchUrlPreview("https://example.com/oob");

    expect(result).not.toBeNull();
    // The entity decodes to "" and clean() collapses the surrounding
    // whitespace to a single space.
    expect(result!.title).toBe("safe title");
  });

  it("rejects meta tags with mismatched quote pairs", async () => {
    // Opening `"` paired with closing `'` — unbalanced markup.
    const html = `<html><head>
      <meta property="og:title" content="mismatch'>
      <title>Fallback OK</title>
    </head></html>`;
    fetchMock.mockResolvedValueOnce(htmlResponse(html));

    const result = await fetchUrlPreview("https://example.com/quotes");

    // og:title is unbalanced, so the parser falls through to <title>.
    expect(result!.title).toBe("Fallback OK");
  });

  it("blocks loopback hosts without fetching (SSRF guard)", async () => {
    expect(await fetchUrlPreview("http://localhost:8081/")).toBeNull();
    expect(await fetchUrlPreview("http://127.0.0.1/admin")).toBeNull();
    expect(await fetchUrlPreview("http://127.0.0.5/")).toBeNull();
    expect(await fetchUrlPreview("http://0.0.0.0/")).toBeNull();
    expect(await fetchUrlPreview("http://[::1]/")).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("blocks cloud metadata service without fetching (SSRF guard)", async () => {
    expect(
      await fetchUrlPreview("http://169.254.169.254/latest/meta-data/"),
    ).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  // Non-canonical IP encodings (#68). RN's URL does no canonicalization, so a
  // string-literal deny-list is bypassed by decimal/hex/octal/short forms even
  // though the native fetch layer resolves them to the real loopback / metadata
  // address. The guard now normalizes to a numeric range before comparing.
  it("blocks decimal-encoded loopback (2130706433 = 127.0.0.1)", async () => {
    expect(await fetchUrlPreview("http://2130706433/")).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("blocks hex-encoded loopback (0x7f000001 = 127.0.0.1)", async () => {
    expect(await fetchUrlPreview("http://0x7f000001/")).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("blocks octal-encoded loopback (0177.0.0.1 = 127.0.0.1)", async () => {
    expect(await fetchUrlPreview("http://0177.0.0.1/")).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("blocks short-form loopback (127.1 = 127.0.0.1)", async () => {
    expect(await fetchUrlPreview("http://127.1/")).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("blocks decimal-encoded cloud metadata (2852039166 = 169.254.169.254)", async () => {
    expect(await fetchUrlPreview("http://2852039166/")).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("blocks IPv6 loopback [::1]", async () => {
    expect(await fetchUrlPreview("http://[::1]/")).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("blocks IPv4-mapped IPv6 loopback [::ffff:127.0.0.1]", async () => {
    expect(await fetchUrlPreview("http://[::ffff:127.0.0.1]/")).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  // Host-normalization bypasses (#68 follow-up). WHATWG URL parsing (and the
  // native fetch layer) strip ASCII tab/newline/CR and treat `\` as `/` in the
  // authority BEFORE dialing; extractHost must normalize identically or the
  // deny-list checks a different host than the socket connects to.
  it("blocks tab-injected loopback (http://12\\t7.0.0.1/ = 127.0.0.1)", async () => {
    expect(await fetchUrlPreview("http://12\t7.0.0.1/")).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("blocks newline-injected loopback (http://127.0.0.1\\n/ = 127.0.0.1)", async () => {
    expect(await fetchUrlPreview("http://127.0.0.1\n/")).toBeNull();
    expect(await fetchUrlPreview("http://12\n7.0.0.1/")).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("blocks backslash-authority bypass (http://127.0.0.1\\@evil.com/ dials 127.0.0.1)", async () => {
    expect(await fetchUrlPreview("http://127.0.0.1\\@evil.com/")).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  // Percent-encoding and Unicode-fold bypasses (#70). OkHttp (Android) percent-
  // decodes and IDNA/NFKC-maps the authority before it dials, so a host that is
  // only a blocked address AFTER decoding still reaches loopback. The guard must
  // normalize the same way, or the deny-list inspects a string the socket never
  // sees.
  it("blocks percent-encoded loopback (%31%32%37%2e%30%2e%30%2e%31 = 127.0.0.1)", async () => {
    expect(
      await fetchUrlPreview("http://%31%32%37%2e%30%2e%30%2e%31/"),
    ).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("blocks partially percent-encoded loopback (127%2e0%2e0%2e1)", async () => {
    expect(await fetchUrlPreview("http://127%2e0%2e0%2e1/")).toBeNull();
    // `%31` decodes to `1`, making the host `127.0.0.1`.
    expect(await fetchUrlPreview("http://%3127.0.0.1/")).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  // RFC1918 stays allowed after decoding — decoding must not widen the
  // deny-list beyond what isBlockedHost deliberately covers. `%31` + `0.0.0.1`
  // decodes to `10.0.0.1`, a LAN address the user may legitimately bookmark.
  it("does not block a percent-encoded RFC1918 host (%310.0.0.1 = 10.0.0.1)", async () => {
    fetchMock.mockResolvedValueOnce(
      htmlResponse("<html><head><title>LAN</title></head></html>"),
    );
    expect(await fetchUrlPreview("http://%310.0.0.1/")).not.toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("blocks percent-encoded cloud metadata (169%2e254%2e169%2e254)", async () => {
    expect(await fetchUrlPreview("http://169%2e254%2e169%2e254/")).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("blocks percent-encoded IPv6 loopback ([%3a%3a1])", async () => {
    expect(await fetchUrlPreview("http://[%3a%3a1]/")).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("blocks percent-encoded 'localhost'", async () => {
    expect(await fetchUrlPreview("http://%6cocalhost/")).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("blocks fullwidth-digit loopback (１２７.0.0.1 NFKC-folds to 127.0.0.1)", async () => {
    expect(await fetchUrlPreview("http://１２７.0.0.1/")).toBeNull();
    expect(
      await fetchUrlPreview(
        "http://１２７．０．０．１/",
      ),
    ).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("blocks IDNA dot-variant loopback (127。0。0。1 = 127.0.0.1)", async () => {
    expect(await fetchUrlPreview("http://127。0。0。1/")).toBeNull();
    expect(await fetchUrlPreview("http://127｡0｡0｡1/")).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("blocks fullwidth-digit decimal loopback (２１３０７０６４３３ = 2130706433)", async () => {
    expect(
      await fetchUrlPreview(
        "http://２１３０７０６４３３/",
      ),
    ).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("blocks a percent-encoded blocked host on a redirect hop", async () => {
    fetchMock.mockResolvedValueOnce({
      status: 302,
      headers: {
        get: (k: string) =>
          k.toLowerCase() === "location"
            ? "http://%31%32%37%2e%30%2e%30%2e%31/"
            : null,
      },
      url: "https://example.com/",
      text: async () => "",
    } as unknown as Response);
    expect(await fetchUrlPreview("https://example.com/")).toBeNull();
    // Only the first hop was fetched; the loopback target was never dialed.
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  // The hop guard must inspect the RAW Location header, not just the value
  // round-tripped through `new URL(...)`. Under Node, URL applies UTS46 and
  // pre-normalizes the host, which would make these pass for a reason that
  // does not exist on-device — RN's URL does zero canonicalization.
  it("blocks an ignored-code-point loopback in a raw redirect Location", async () => {
    fetchMock.mockResolvedValueOnce({
      status: 302,
      headers: {
        get: (k: string) =>
          k.toLowerCase() === "location" ? "http://127.0.0.1­/" : null,
      },
      url: "https://example.com/",
      text: async () => "",
    } as unknown as Response);
    expect(await fetchUrlPreview("https://example.com/")).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  // An undecodable escape (`%zz`) makes the URL invalid outright — `new URL`
  // rejects it, so the preview fails closed at the parse step and never reaches
  // the guard. The requirement here is that `percentDecodeOnce` swallowing the
  // `decodeURIComponent` throw does not turn into an exception escaping
  // fetchUrlPreview, and that no fetch is issued.
  it("malformed percent-escapes fail closed without throwing (%zz)", async () => {
    fetchMock.mockResolvedValue(
      htmlResponse("<html><head><title>OK</title></head></html>"),
    );
    await expect(fetchUrlPreview("http://ex%zzample.com/")).resolves.toBeNull();
    await expect(fetchUrlPreview("http://127.0.0.1%zz/")).resolves.toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  // UTS46 `ignored` code points (#70 review follow-up). The IDNA host mapper
  // DELETES these before resolution — `127.0.0.1<soft-hyphen>` dials 127.0.0.1 —
  // and NFKC does not remove them, so neither the width fold nor normalize()
  // catches them. This is the third UTS46 mapping category; the original fix
  // only covered `mapped` and NFKC-equivalent forms.
  it("blocks loopback obscured by IDNA-ignored code points", async () => {
    expect(await fetchUrlPreview("http://127.0.0.1­/")).toBeNull();
    expect(await fetchUrlPreview("http://12​7.0.0.1/")).toBeNull();
    expect(await fetchUrlPreview("http://12︀7.0.0.1/")).toBeNull();
    expect(await fetchUrlPreview("http://2130706433͏/")).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("blocks 'localhost' and metadata obscured by IDNA-ignored code points", async () => {
    expect(await fetchUrlPreview("http://local­host/admin")).toBeNull();
    expect(await fetchUrlPreview("http://local⁠host/")).toBeNull();
    expect(
      await fetchUrlPreview("http://169.254.169.254‍/latest/meta-data/"),
    ).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("blocks fullwidth percent-sign encoding (％31％32％37 folds then decodes)", async () => {
    expect(
      await fetchUrlPreview("http://％31％32％37.0.0.1/"),
    ).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("blocks IPv6 loopback carrying an RFC6874 zone ID ([::1%25eth0])", async () => {
    expect(await fetchUrlPreview("http://[::1%25eth0]/")).toBeNull();
    expect(await fetchUrlPreview("http://[::1%eth0]/")).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  // The guard must not silently degrade on a Hermes build without full ICU,
  // (see the direct-guard describe block below for the cases Node's URL rejects)
  // where String.prototype.normalize may no-op. CI runs on Node (full ICU), so
  // the fallback path is only ever exercised by forcing it here.
  describe("with NFKC unavailable (no-ICU Hermes build)", () => {
    beforeEach(() => {
      vi.spyOn(String.prototype, "normalize").mockImplementation(function (
        this: string,
      ) {
        return String(this);
      });
    });

    it("still blocks dot-variant loopback (U+2024, U+FE52)", async () => {
      expect(
        await fetchUrlPreview("http://127․0․0․1/"),
      ).toBeNull();
      expect(
        await fetchUrlPreview("http://127﹒0﹒0﹒1/"),
      ).toBeNull();
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it("still blocks superscript / circled / math digit loopback", async () => {
      expect(await fetchUrlPreview("http://¹²⁷.0.0.1/")).toBeNull();
      expect(await fetchUrlPreview("http://①②⑦.0.0.1/")).toBeNull();
      expect(
        await fetchUrlPreview("http://\u{1D7D9}\u{1D7DA}\u{1D7DF}.0.0.1/"),
      ).toBeNull();
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it("still blocks fullwidth and ignored-code-point forms", async () => {
      expect(await fetchUrlPreview("http://１２７.0.0.1/")).toBeNull();
      expect(await fetchUrlPreview("http://127.0.0.1­/")).toBeNull();
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it("still allows a genuine public host", async () => {
      fetchMock.mockResolvedValueOnce(
        htmlResponse("<html><head><title>Public</title></head></html>"),
      );
      expect(await fetchUrlPreview("https://example.com/")).not.toBeNull();
    });
  });

  it("does not block a genuine public host containing a percent escape", async () => {
    fetchMock.mockResolvedValueOnce(
      htmlResponse("<html><head><title>Public</title></head></html>"),
    );
    const result = await fetchUrlPreview("https://ex%61mple.com/");
    expect(result).not.toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("does not block a genuine internationalized (IDN) host", async () => {
    fetchMock.mockResolvedValueOnce(
      htmlResponse("<html><head><title>IDN</title></head></html>"),
    );
    const result = await fetchUrlPreview("https://bücher.example/");
    expect(result).not.toBeNull();
    expect(result!.title).toBe("IDN");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("does not block a genuine public HTTPS host (no false positive)", async () => {
    fetchMock.mockResolvedValueOnce(
      htmlResponse("<html><head><title>Public</title></head></html>"),
    );
    const result = await fetchUrlPreview("https://example.com/");
    expect(result).not.toBeNull();
    expect(result!.title).toBe("Public");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("allows general private RFC1918 ranges (self-hosted is legitimate)", async () => {
    fetchMock.mockResolvedValueOnce(
      htmlResponse("<html><head><title>Internal Wiki</title></head></html>"),
    );
    const result = await fetchUrlPreview("http://192.168.1.10/wiki");
    expect(result).not.toBeNull();
    expect(result!.title).toBe("Internal Wiki");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("still previews a public URL with a literal backslash in the path", async () => {
    // The `\` sits AFTER the authority boundary (`/` comes first), so it must
    // NOT be treated as a host terminator — the host is still example.com and
    // the preview proceeds normally.
    fetchMock.mockResolvedValueOnce(
      htmlResponse("<html><head><title>Doc Ref</title></head></html>"),
    );
    const result = await fetchUrlPreview("https://example.com/docs\\ref?q=1");
    expect(result).not.toBeNull();
    expect(result!.title).toBe("Doc Ref");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

/** Direct assertions on the SSRF guard.
 *
 * Node's `URL` rejects several hostile hosts outright (`Invalid URL`), so a
 * black-box test through fetchUrlPreview passes for those whether or not the
 * guard works — the preview already failed closed at the parse step. React
 * Native's `URL` does no such validation and hands the raw authority to the
 * native fetch layer, so these are the cases where the guard is the ONLY
 * defense, and they have to be asserted against the guard itself. */
describe("isBlockedHost (direct — inputs Node's URL rejects)", () => {
  it("blocks dot-variant loopback that new URL() will not parse", () => {
    // Sanity: these really are rejected upstream, so the black-box path
    // cannot be what is covering them.
    expect(() => new URL("http://127․ 0․ 0․1/")).toThrow();

    expect(isBlockedHost("127․0․0․1")).toBe(true);
    expect(isBlockedHost("127﹒0﹒0﹒1")).toBe(true);
    expect(isBlockedHost("127。0。0。1")).toBe(true);
    expect(isBlockedHost("169․254․169․254")).toBe(true);
  });

  it("blocks IPv6 loopback carrying an RFC6874 zone ID", () => {
    expect(isBlockedHost("::1%25eth0")).toBe(true);
    expect(isBlockedHost("::1%eth0")).toBe(true);
    expect(isBlockedHost("[::1%25lo]")).toBe(true);
    expect(isBlockedHost("::ffff:127.0.0.1%25eth0")).toBe(true);
  });

  it("blocks IDNA-ignored code points infixed anywhere in the host", () => {
    expect(isBlockedHost("127.0.0.1­")).toBe(true);
    expect(isBlockedHost("12​7.0.0.1")).toBe(true);
    expect(isBlockedHost("local­host")).toBe(true);
    expect(isBlockedHost("local﻿host")).toBe(true);
    expect(isBlockedHost("2130706433͏")).toBe(true);
    expect(isBlockedHost("12︀7.0.0.1")).toBe(true);
  });

  it("blocks percent-encoded and width-folded forms", () => {
    expect(isBlockedHost("%31%32%37%2e%30%2e%30%2e%31")).toBe(true);
    expect(isBlockedHost("１２７.0.0.1")).toBe(true);
    expect(isBlockedHost("％31%32%37.0.0.1")).toBe(true);
  });

  it("does not block hosts that are genuinely not blocked", () => {
    // RFC1918 is deliberately allowed — see isBlockedHost JSDoc.
    expect(isBlockedHost("10.0.0.1")).toBe(false);
    expect(isBlockedHost("192.168.1.10")).toBe(false);
    expect(isBlockedHost("example.com")).toBe(false);
    expect(isBlockedHost("bücher.example")).toBe(false);
    // Arabic-Indic digits are `valid` (not mapped) under UTS46 and are not
    // NFKC-equivalent to ASCII digits, so this never resolves to loopback.
    expect(isBlockedHost("١٢٧.0.0.1")).toBe(false);
    expect(isBlockedHost("")).toBe(false);
  });

  it("is monotone: normalization can only ever tighten the guard", () => {
    // Any host the pre-normalization logic blocked must still be blocked.
    const previouslyBlocked = [
      "127.0.0.1",
      "localhost",
      "0.0.0.0",
      "169.254.169.254",
      "2130706433",
      "0x7f000001",
      "0177.0.0.1",
      "127.1",
      "::1",
      "::ffff:127.0.0.1",
      "127.0.0.1.",
    ];
    for (const h of previouslyBlocked) {
      expect(isBlockedHost(h), `${h} must stay blocked`).toBe(true);
    }
  });

  it("extractHost strips userinfo, port and brackets before the guard sees it", () => {
    expect(extractHost("http://user:pass@127.0.0.1:8080/x")).toBe("127.0.0.1");
    expect(extractHost("http://[::1]:9/")).toBe("::1");
    expect(extractHost("http://127.0.0.1\\@evil.com/")).toBe("127.0.0.1");
    expect(extractHost("not-a-url")).toBeNull();
  });
});

describe("fetchUrlPreview adversarial HTML (ReDoS)", () => {
  const BUDGET_MS = 1000;
  const cases: ReadonlyArray<readonly [string, string]> = [
    ["unterminated <meta tags", "<meta ".repeat(40_000)],
    ["unterminated <p tags", "<p ".repeat(80_000)],
    ["nested <p> without close", "<p>".repeat(80_000)],
    ["unterminated <title tags", "<title ".repeat(30_000)],
    ["unclosed < inside <p> body", `<p>${"<a ".repeat(80_000)}`],
  ];

  for (const [label, junk] of cases) {
    it(`parses ${label} in linear time`, async () => {
      fetchMock.mockResolvedValueOnce(
        htmlResponse(`<html><head><title>T</title></head>${junk}`),
      );
      const start = Date.now();
      const result = await fetchUrlPreview("https://example.com/evil");
      expect(Date.now() - start).toBeLessThan(BUDGET_MS);
      expect(result?.title).toBe("T");
    });
  }
});
