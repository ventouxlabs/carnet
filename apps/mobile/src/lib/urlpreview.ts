/**
 * URL preview fetcher for the share-target link path.
 *
 * Given a URL, fetch the raw HTML and extract a small set of
 * structured fields (`<title>`, `og:*`, `<meta name="description">`,
 * first `<p>`) so the LLM has real page content to summarize from
 * instead of guessing from the URL slug.
 *
 * Design decisions:
 *   - **Never throws.** All failure modes (invalid URL, network error,
 *     timeout, non-200, non-HTML, parse failure) collapse to `null`
 *     so the caller can fall back to the URL-string-only prompt.
 *   - **8-second timeout.** Faster than the 60s chat-completion budget
 *     because preview is best-effort — better to skip it than block
 *     the user.
 *   - **256 KB body cap.** RN's fetch doesn't expose response streaming
 *     cleanly; we read the full text and slice. The cap is well above
 *     a typical `<head>` block.
 *   - **Regex parsing, not DOM.** No DOM available in RN, and the
 *     surface we need is tiny (a handful of tags). Falls back to null
 *     gracefully on weird markup.
 *   - **Mozilla UA.** Many sites 403 the default RN fetch UA. We
 *     identify carnet in the comment portion for honest reporting.
 *
 * Threat model: page content may contain prompt-injection attempts
 * (`<title>Ignore previous instructions...</title>`). The caller MUST
 * thread the preview through the `<USER_INPUT>` envelope so the
 * existing INJECTION_GUARD covers it.
 */

const FETCH_TIMEOUT_MS = 8_000;
/** Body cap measured in UTF-16 code units (JS `string.length`), NOT
 * bytes — a multibyte-heavy page can occupy ~2× this in actual bytes,
 * but the head we care about always sits in the first few thousand
 * chars regardless of encoding. */
const MAX_BODY_CHARS = 256 * 1024;
const FIELD_CHAR_LIMIT = 500;
const USER_AGENT =
  "Mozilla/5.0 (compatible; carnet/0.2; +https://github.com/ventouxlabs/carnet)";

export interface UrlPreview {
  /** Best of `<title>` and `og:title`. */
  title: string;
  /** `og:description`, `twitter:description`, or first `<p>` text. */
  description: string;
  /** `og:site_name` or hostname. */
  siteName: string;
  /** From the response `content-type` header. */
  contentType: string;
}

/** Maximum valid Unicode code point. `String.fromCodePoint` throws
 * `RangeError` for anything above this, so numeric entities are
 * clamp-checked rather than passed through blindly. */
const MAX_CODE_POINT = 0x10ffff;

/** Decode the most common HTML entities. We don't pull in a full
 * decoder because the fields we extract are short and predictable.
 * Out-of-range numeric entities (`&#1114112;` and friends) decode to
 * the empty string instead of bubbling a `RangeError`. */
function decodeEntities(s: string): string {
  return s
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&apos;/gi, "'")
    .replace(/&nbsp;/gi, " ")
    .replace(/&#(\d+);/g, (_, code: string) => {
      const n = parseInt(code, 10);
      if (!Number.isFinite(n) || n < 0 || n > MAX_CODE_POINT) return "";
      return String.fromCodePoint(n);
    })
    .replace(/&#x([0-9a-f]+);/gi, (_, hex: string) => {
      const n = parseInt(hex, 16);
      if (!Number.isFinite(n) || n < 0 || n > MAX_CODE_POINT) return "";
      return String.fromCodePoint(n);
    });
}

/** Collapse whitespace and trim to the per-field limit. */
function clean(s: string): string {
  const collapsed = decodeEntities(s).replace(/\s+/g, " ").trim();
  return collapsed.length > FIELD_CHAR_LIMIT
    ? collapsed.slice(0, FIELD_CHAR_LIMIT).trimEnd()
    : collapsed;
}

/** Find the first match of a regex; return `clean()`-ed capture group 1
 * or empty string. Case-insensitive by convention at the call site. */
function firstMatch(html: string, re: RegExp): string {
  const m = html.match(re);
  if (!m || typeof m[1] !== "string") return "";
  return clean(m[1]);
}

/** Extract a `<meta>` value where the attribute order may be
 * `property|name="X" content="Y"` OR `content="Y" property|name="X"`.
 * Both shapes are common in the wild. Quote characters are captured
 * and backreferenced so mismatched pairs (`content="foo'`) don't
 * match — protects against unbalanced markup. */
function metaContent(html: string, key: string): string {
  const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  // attr-first: <meta property="og:title" content="...">
  // Capture group 1 = key quote, 2 = key, 3 = content quote, 4 = content value.
  const a = new RegExp(
    `<meta[^>]*(?:property|name)\\s*=\\s*(["'])${escaped}\\1[^>]*content\\s*=\\s*(["'])([^"']*)\\2`,
    "i",
  );
  const matchA = html.match(a);
  if (matchA && typeof matchA[3] === "string") {
    const cleaned = clean(matchA[3]);
    if (cleaned) return cleaned;
  }
  // content-first: <meta content="..." property="og:title">
  const b = new RegExp(
    `<meta[^>]*content\\s*=\\s*(["'])([^"']*)\\1[^>]*(?:property|name)\\s*=\\s*(["'])${escaped}\\3`,
    "i",
  );
  const matchB = html.match(b);
  if (matchB && typeof matchB[2] === "string") {
    return clean(matchB[2]);
  }
  return "";
}

/** Pull the textual content of the first `<p>` tag, stripping nested
 * tags. Used only as a last-resort description fallback.
 *
 * The opening-tag regex is `<p` then either nothing or a whitespace-
 * led attribute block — written as `(?:\s[^>]*)?` so we cleanly
 * consume the entire opening tag before starting to capture the body.
 * A loose `<p[^>]*>` would also work but `<p` followed by another
 * letter (e.g. `<pre>`) would match it. */
function firstParagraph(html: string): string {
  const m = html.match(/<p(?:\s[^>]*)?>([\s\S]*?)<\/p>/i);
  if (!m || typeof m[1] !== "string") return "";
  const stripped = m[1].replace(/<[^>]+>/g, " ");
  return clean(stripped);
}

/** Extract the raw host (userinfo and port stripped) from a URL string
 * WITHOUT relying on `URL.hostname`.
 *
 * React Native's built-in `URL` (no `react-native-url-polyfill` installed)
 * does zero canonicalization: `hostname` returns the raw substring, and for
 * bracketed IPv6 literals it mangles `[::1]` down to `[`. The native fetch
 * layer (OkHttp / NSURLSession), however, DOES canonicalize before it
 * connects — so a deny-list keyed off `URL.hostname` sees a different host
 * than the one the socket actually dials. We parse the authority by hand so
 * the SSRF check operates on the same host the native layer will resolve,
 * and so the behavior is identical on-device and under the Node test URL. */
export function extractHost(rawUrl: string): string | null {
  // WHATWG URL parsing strips ASCII tab / newline / carriage-return from the
  // URL *before* parsing, and the native fetch layer (OkHttp / NSURLSession)
  // does the same before it dials — so we must strip them first, or a byte
  // injected into the host (`http://12\t7.0.0.1/`) is seen here as the literal
  // `12<TAB>7.0.0.1` (which fails IP parsing) while the socket resolves the
  // stripped `127.0.0.1` and connects to loopback anyway.
  const cleaned = rawUrl.replace(/[\t\n\r]/g, "");
  const schemeMatch = cleaned.match(/^[a-z][a-z0-9+.-]*:\/\//i);
  if (!schemeMatch) return null;
  const rest = cleaned.slice(schemeMatch[0].length);
  // Authority ends at the first path / query / fragment delimiter. For special
  // (http/https) schemes WHATWG treats a backslash the same as a forward slash
  // when locating the authority boundary, so `\` also terminates the authority:
  // `http://127.0.0.1\@evil.com/` dials 127.0.0.1, not evil.com. The scan stops
  // at the FIRST such delimiter, so a legitimate `\` later in the path or query
  // is never reached and stays untouched.
  const authEnd = rest.search(/[/\\?#]/);
  let authority = authEnd === -1 ? rest : rest.slice(0, authEnd);
  // Drop any userinfo (`user:pass@`).
  const at = authority.lastIndexOf("@");
  if (at !== -1) authority = authority.slice(at + 1);
  if (authority.startsWith("[")) {
    // Bracketed IPv6 literal — return the inner address, no brackets.
    const close = authority.indexOf("]");
    if (close === -1) return null;
    return authority.slice(1, close).toLowerCase();
  }
  // Strip a `:port` suffix (IPv6 without brackets is not a valid URL host).
  const colon = authority.indexOf(":");
  if (colon !== -1) authority = authority.slice(0, colon);
  return authority.toLowerCase();
}

/** Parse a single IPv4 component in decimal, hex (`0x`-prefixed), or octal
 * (leading `0`) form — the encodings `inet_aton`/browsers/curl accept.
 * Returns the numeric value, or null when the component is not a pure number
 * in one of those bases (i.e. it's a real DNS label like `example`). */
function parseIpv4Part(s: string): number | null {
  if (s.length === 0) return null;
  let radix: number;
  let digits: string;
  if (/^0x/i.test(s)) {
    radix = 16;
    digits = s.slice(2);
    if (!/^[0-9a-f]+$/i.test(digits)) return null;
  } else if (s[0] === "0" && s.length > 1) {
    radix = 8;
    digits = s.slice(1);
    if (!/^[0-7]+$/.test(digits)) return null;
  } else {
    radix = 10;
    digits = s;
    if (!/^[0-9]+$/.test(digits)) return null;
  }
  const n = parseInt(digits, radix);
  return Number.isFinite(n) ? n : null;
}

/** Render a 32-bit integer as dotted-decimal IPv4. */
function intToDotted(value: number): string {
  const b0 = Math.floor(value / 16777216) % 256;
  const b1 = Math.floor(value / 65536) % 256;
  const b2 = Math.floor(value / 256) % 256;
  const b3 = value % 256;
  return `${b0}.${b1}.${b2}.${b3}`;
}

/** Canonicalize a host to dotted-decimal IPv4 if — and only if — it parses as
 * an IPv4 address in ANY encoding (dotted-decimal, single decimal integer,
 * hex, octal, or a short/partial form like `127.1`). Returns null for real
 * hostnames so they fall through to normal DNS resolution.
 *
 * Follows the `inet_aton` "last part absorbs the remaining bytes" rule:
 * `127.1` → `127.0.0.1`, `2130706433` → `127.0.0.1`. */
function canonicalizeIPv4(host: string): string | null {
  const parts = host.split(".");
  if (parts.length < 1 || parts.length > 4) return null;
  const nums: number[] = [];
  for (const p of parts) {
    const n = parseIpv4Part(p);
    if (n === null) return null;
    nums.push(n);
  }
  const count = nums.length;
  let value = 0;
  for (let i = 0; i < count; i++) {
    const isLast = i === count - 1;
    // The last component absorbs all bytes not claimed by earlier ones.
    const bytes = isLast ? 4 - (count - 1) : 1;
    const max = Math.pow(256, bytes) - 1;
    if (nums[i] < 0 || nums[i] > max) return null;
    value += isLast ? nums[i] : nums[i] * Math.pow(256, 3 - i);
  }
  if (value < 0 || value > 0xffffffff) return null;
  return intToDotted(value);
}

/** Expand an IPv6 literal to its 8 hextets, folding a trailing embedded IPv4
 * (`::ffff:127.0.0.1`) into two hextets first. Returns null if it does not
 * parse as IPv6. Lenient by design — it only feeds the loopback/link-local
 * block check, where over-recognizing never loosens the guard. */
function expandIPv6(input: string): number[] | null {
  // Strip an RFC6874 zone ID (`::1%25eth0`, or `::1%eth0` once percent-decoded).
  // The zone is interface scope metadata, not part of the address — leaving it
  // attached makes the hextet parse fail and the address read as "not IPv6",
  // which would silently unblock `[::1%25eth0]`.
  let s = input.toLowerCase().replace(/%(?:25)?[^%]*$/, "");
  if (s.length === 0) return null;
  // Fold a trailing dotted-quad (`::ffff:127.0.0.1`) into two hextets.
  if (s.includes(".")) {
    const lastColon = s.lastIndexOf(":");
    if (lastColon === -1) return null;
    const octs = s.slice(lastColon + 1).split(".");
    if (octs.length !== 4) return null;
    const v = octs.map((o) => (/^[0-9]+$/.test(o) ? parseInt(o, 10) : -1));
    if (v.some((x) => x < 0 || x > 255)) return null;
    const hi = (v[0] << 8) | v[1];
    const lo = (v[2] << 8) | v[3];
    s = `${s.slice(0, lastColon + 1)}${hi.toString(16)}:${lo.toString(16)}`;
  }
  const halves = s.split("::");
  if (halves.length > 2) return null;
  const parseSeg = (seg: string): number[] | null => {
    if (seg === "") return [];
    const out: number[] = [];
    for (const h of seg.split(":")) {
      if (!/^[0-9a-f]{1,4}$/.test(h)) return null;
      out.push(parseInt(h, 16));
    }
    return out;
  };
  if (halves.length === 1) {
    const all = parseSeg(halves[0]);
    return all && all.length === 8 ? all : null;
  }
  const head = parseSeg(halves[0]);
  const tail = parseSeg(halves[1]);
  if (!head || !tail) return null;
  const missing = 8 - head.length - tail.length;
  if (missing < 0) return null;
  return [...head, ...new Array(missing).fill(0), ...tail];
}

/** True when a canonical dotted-decimal IPv4 falls in a blocked range:
 * `0.0.0.0/8` (this-host), `127.0.0.0/8` (loopback), or `169.254.0.0/16`
 * (link-local, which contains the `169.254.169.254` cloud-metadata endpoint).
 * RFC1918 private ranges (`10.*`, `172.16-31.*`, `192.168.*`) are deliberately
 * NOT here — see {@link isBlockedHost}. */
function isBlockedIPv4(dotted: string): boolean {
  const [a, b] = dotted.split(".").map(Number);
  if (a === 0) return true;
  if (a === 127) return true;
  if (a === 169 && b === 254) return true;
  return false;
}

/** True when the expanded IPv6 address is a blocked loopback / mapped form. */
function isBlockedIPv6(hextets: number[]): boolean {
  // ::1 loopback.
  if (hextets.slice(0, 7).every((x) => x === 0) && hextets[7] === 1) return true;
  // :: unspecified — equivalent to 0.0.0.0.
  if (hextets.every((x) => x === 0)) return true;
  // IPv4-mapped (`::ffff:a.b.c.d`) or IPv4-compatible (`::a.b.c.d`): the low
  // 32 bits carry an IPv4 address we re-run through the v4 range check.
  const first5Zero = hextets.slice(0, 5).every((x) => x === 0);
  if (first5Zero && (hextets[5] === 0xffff || hextets[5] === 0)) {
    const value = hextets[6] * 65536 + hextets[7];
    return isBlockedIPv4(intToDotted(value));
  }
  return false;
}

/** Unicode code points IDNA maps to an ASCII label separator (`.`): ideographic
 * full stop, fullwidth full stop, halfwidth ideographic full stop. NFKC folds
 * the latter two but leaves U+3002 alone, so we fold all three by hand. */
const IDNA_DOT_VARIANTS = /[。．｡․﹒]/g;

/** UTS46 `ignored` code points: the IDNA host mapper DELETES these before
 * resolution, so `127.0.0.1<U+00AD>` dials `127.0.0.1`. NFKC does NOT remove
 * them and they sit outside the fullwidth block, so without this they slip past
 * both normalization layers — the third UTS46 mapping category. */
const IDNA_IGNORED =
  /[­͏᠋-᠍᠏​-‍⁠-⁤︀-️﻿]/g;

/** Non-fullwidth code points NFKC folds to an ASCII digit, as an explicit
 * table: superscripts, subscripts, and circled/parenthesized/dotted digits.
 *
 * Applied unconditionally rather than only when NFKC is missing, so the guard
 * behaves identically on Node (full ICU, where CI runs) and on a Hermes build
 * without it. Folding more can only add variants, and a variant set can only
 * tighten the deny-list — so there is no reason to make this conditional. */
const DIGIT_FOLDS: ReadonlyArray<readonly [RegExp, string]> = [
  [/[⁰₀]/g, "0"],
  [/[¹₁①⑴⒈]/g, "1"],
  [/[²₂②⑵⒉]/g, "2"],
  [/[³₃③⑶⒊]/g, "3"],
  [/[⁴₄④⑷⒋]/g, "4"],
  [/[⁵₅⑤⑸⒌]/g, "5"],
  [/[⁶₆⑥⑹⒍]/g, "6"],
  [/[⁷₇⑦⑺⒎]/g, "7"],
  [/[⁸₈⑧⑻⒏]/g, "8"],
  [/[⁹₉⑨⑼⒐]/g, "9"],
];

/** Mathematical Alphanumeric Symbols digit runs (U+1D7CE–U+1D7FF), each a
 * contiguous 0-9 block, folded by offset. */
const MATH_DIGIT_BASES = [0x1d7ce, 0x1d7d8, 0x1d7e2, 0x1d7ec, 0x1d7f6];

/** True when the runtime performs real NFKC. Probed rather than assumed: a
 * Hermes build without full ICU can expose `normalize` that silently returns
 * its input, which would look identical to a successful fold. */
const HAS_NFKC = ((): boolean => {
  try {
    return "․".normalize("NFKC") === ".";
  } catch {
    return false;
  }
})();

/** Fold a host toward the ASCII form the IDNA host mapper would produce:
 * the Halfwidth-and-Fullwidth-Forms block (U+FF01–U+FF5E, a fixed 0xFEE0
 * offset), the IDNA dot variants, and the `ignored` code points.
 *
 * Done by hand rather than relying solely on `String.prototype.normalize`
 * because `ignored` code points are not an NFKC transformation at all, and
 * because NFKC is not guaranteed on a Hermes build without full ICU. When
 * {@link HAS_NFKC} is false the explicit digit table above stands in for the
 * folds `normalize` would otherwise have done. */
function foldWidth(s: string): string {
  let out = "";
  for (const ch of s) {
    const cp = ch.codePointAt(0)!;
    if (cp >= 0xff01 && cp <= 0xff5e) {
      out += String.fromCharCode(cp - 0xfee0);
      continue;
    }
    const mathBase = MATH_DIGIT_BASES.find((b) => cp >= b && cp <= b + 9);
    out += mathBase === undefined ? ch : String(cp - mathBase);
  }
  out = out.replace(IDNA_DOT_VARIANTS, ".").replace(IDNA_IGNORED, "");
  for (const [pattern, digit] of DIGIT_FOLDS) {
    out = out.replace(pattern, digit);
  }
  return out;
}

/** Apply NFKC when the runtime genuinely supports it, otherwise pass through —
 * {@link foldWidth} has already covered the fallback cases. */
function nfkc(s: string): string {
  try {
    return HAS_NFKC ? s.normalize("NFKC") : s;
  } catch {
    return s;
  }
}

/** Percent-decode once, mirroring what OkHttp/WHATWG do to the authority before
 * dialing. Returns null when there is nothing to decode or the input contains a
 * malformed escape (`%zz`), so callers fall back to the undecoded form. */
function percentDecodeOnce(s: string): string | null {
  if (!s.includes("%")) return null;
  try {
    const decoded = decodeURIComponent(s);
    return decoded === s ? null : decoded;
  } catch {
    return null;
  }
}

/** Every host spelling the native layer might resolve this raw host to.
 *
 * The deny-list is evaluated against ALL of them and blocks if ANY is blocked,
 * so normalization can only ever tighten the guard — a decoding quirk that
 * produces a nonsense variant costs a wasted comparison, never an unblocked
 * loopback. The raw host is always included first so existing behavior is
 * strictly preserved.
 *
 * Both orders of (decode, fold) are generated: `%FF11` needs decoding before
 * folding, while a fullwidth percent sign (`％31`) needs folding before
 * decoding. */
function hostVariants(rawHost: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const push = (v: string | null): void => {
    if (v && !seen.has(v)) {
      seen.add(v);
      out.push(v);
    }
  };
  push(rawHost);
  push(percentDecodeOnce(rawHost));
  // Snapshot: we fold each raw/decoded form, then re-decode the folded result.
  for (const base of [...out]) {
    const folded = nfkc(foldWidth(base)).toLowerCase();
    push(folded);
    const reDecoded = percentDecodeOnce(folded);
    if (reDecoded) push(nfkc(foldWidth(reDecoded)).toLowerCase());
  }
  return out;
}

/** SSRF guard: hosts that should NEVER be reached by a URL preview
 * fetch, even though the device's network position could otherwise
 * reach them.
 *
 *   - loopback (`localhost`, `127.0.0.0/8`, `::1`, `0.0.0.0/8`) — pointing
 *     a preview at the user's own device serves no legitimate purpose
 *     and exposes any locally-bound dev servers.
 *   - link-local cloud metadata (`169.254.0.0/16`, incl. `169.254.169.254`) —
 *     the AWS/GCP/Azure instance metadata service. High-value SSRF target.
 *
 * The check normalizes non-canonical IP encodings BEFORE comparing, so
 * decimal (`2130706433`), hex (`0x7f000001`), octal (`0177.0.0.1`), short
 * (`127.1`), and IPv4-mapped-IPv6 (`::ffff:127.0.0.1`) forms of a blocked
 * address are all caught — RN's `URL` does not canonicalize these but the
 * native fetch layer resolves them to the real loopback/link-local address.
 * Membership is tested by numeric range, not string literal.
 *
 * The host is additionally percent-decoded and width/NFKC-folded before those
 * comparisons (see {@link hostVariants}), because OkHttp decodes and IDNA-maps
 * the authority before dialing: `%31%32%37%2e%30%2e%30%2e%31` and the
 * fullwidth `１２７.0.0.1` both reach `127.0.0.1` on-device. Every spelling is
 * checked and any single blocked match blocks, so normalization can only
 * tighten the guard, never loosen it.
 *
 * General RFC1918 private ranges (`10.*`, `172.16-31.*`, `192.168.*`)
 * are deliberately NOT blocked: the user may legitimately bookmark
 * self-hosted services on their LAN. The user's threat model here is
 * "I am sharing my own URLs", not "an attacker is pivoting through
 * my shares". A blocked-hosts list lives at the boundary; a wider
 * deny-list belongs in a future explicit setting.
 *
 * `rawHost` must be an already-extracted host (see {@link extractHost}),
 * not a full URL — no scheme, no port, no brackets required. */
export function isBlockedHost(rawHost: string): boolean {
  return hostVariants(rawHost).some(isBlockedHostExact);
}

/** The deny-list decision for one exact host spelling. Callers go through
 * {@link isBlockedHost}, which runs this over every normalized variant. */
function isBlockedHostExact(rawHost: string): boolean {
  // Strip a trailing root dot (`127.0.0.1.` resolves the same as `127.0.0.1`).
  const h = rawHost.trim().toLowerCase().replace(/\.$/, "");
  if (h === "") return false;
  const unbracketed = h.startsWith("[") && h.endsWith("]") ? h.slice(1, -1) : h;
  if (unbracketed === "localhost") return true;
  if (unbracketed.includes(":")) {
    const hextets = expandIPv6(unbracketed);
    return hextets ? isBlockedIPv6(hextets) : false;
  }
  const dotted = canonicalizeIPv4(unbracketed);
  return dotted ? isBlockedIPv4(dotted) : false;
}

/** The SSRF guard internals, exported for direct unit testing.
 *
 * Not part of the module's intended API — but these MUST be testable without
 * going through {@link fetchUrlPreview}, because Node's `URL` rejects several
 * of the hostile inputs this guard exists to stop (`http://127․0․0․1/`,
 * `http://[::1%25eth0]/` both throw `Invalid URL`). A black-box test of those
 * cases passes whether or not the guard works, since the preview already
 * failed closed at the parse step. React Native's `URL` is far more permissive
 * and forwards them intact — so on-device the guard is the only thing standing
 * between those strings and the socket, and it has to be asserted directly. */
export const __ssrfGuardInternals = { extractHost, isBlockedHost } as const;

/** Maximum redirect hops to follow before giving up. Guards against redirect
 * loops and a malicious server dragging out the fetch with an endless 3xx
 * chain. */
const MAX_REDIRECTS = 5;

/** HTTP status codes that carry a `Location` header we follow manually. */
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

/** A completed redirect chain: the final response plus the URL it came from.
 * `finalUrl` is what callers that resolve short links (mapsLink.ts) need —
 * `Response.url` is unset under `redirect: "manual"` on RN and in tests. */
export interface RedirectResult {
  response: Response;
  finalUrl: string;
}

/** Internal: follow redirects MANUALLY (`redirect: "manual"`), re-running the
 * SSRF host guard on every hop.
 *
 * `redirect: "follow"` would let a public page 3xx-redirect to `localhost`,
 * `169.254.169.254`, or a LAN host and the browser/RN engine would silently
 * fire the follow-up GET before we could inspect the target — the exact SSRF
 * hole isBlockedHost is meant to close. Following by hand lets us validate the
 * scheme AND host of each redirect target before issuing the next request. */
export async function followWithRedirects(
  startUrl: string,
  signal: AbortSignal,
): Promise<RedirectResult> {
  let currentUrl = startUrl;
  let redirects = 0;
  for (;;) {
    const response = await fetch(currentUrl, {
      method: "GET",
      redirect: "manual",
      headers: {
        "User-Agent": USER_AGENT,
        Accept: "text/html,application/xhtml+xml",
      },
      signal,
    });
    if (!REDIRECT_STATUSES.has(response.status)) {
      return { response, finalUrl: currentUrl };
    }

    // A 3xx with no Location is malformed — hand it back so the caller's
    // `!response.ok` path collapses it to null rather than looping.
    const location = response.headers.get("location");
    if (!location) return { response, finalUrl: currentUrl };

    redirects += 1;
    if (redirects > MAX_REDIRECTS) {
      throw new Error(`URL preview: too many redirects (>${MAX_REDIRECTS})`);
    }

    let next: URL;
    try {
      // Resolve relative Location headers against the current URL.
      next = new URL(location, currentUrl);
    } catch {
      throw new Error("URL preview: invalid redirect Location");
    }
    if (next.protocol !== "http:" && next.protocol !== "https:") {
      throw new Error("URL preview: redirect to non-http(s) scheme blocked");
    }
    // SSRF guard on EVERY hop — see isBlockedHost JSDoc for the threat model.
    // Extract the host from the raw URL string rather than `next.hostname`:
    // RN's URL leaves non-canonical IP encodings and bracketed IPv6 unparsed.
    //
    // Check the RAW Location header as well as the round-tripped URL. Node's
    // URL applies UTS46 and hands back an already-normalized host, so guarding
    // only `next` would pass under test while RN's URL — which canonicalizes
    // nothing (see extractHost) — forwards the obfuscated host straight to the
    // socket. Guarding the raw string is what actually holds on-device; the
    // parsed form is kept because it resolves relative Location values.
    const rawTarget = /^[a-z][a-z0-9+.-]*:\/\//i.test(location)
      ? location
      : next.toString();
    const rawHost = extractHost(rawTarget);
    if (
      (rawHost !== null && isBlockedHost(rawHost)) ||
      isBlockedHost(extractHost(next.toString()) ?? next.hostname)
    ) {
      throw new Error("URL preview: redirect to blocked host");
    }
    currentUrl = next.toString();
  }
}

/** Internal: do the fetch with a HARD timeout, following redirects manually.
 * Rejects on timeout or a blocked redirect target; propagates other fetch
 * errors (the sole caller maps any throw to null).
 *
 * Races the whole redirect chain against an independent reject-timer because
 * RN's fetch does not reject when AbortController.abort() fires during a stuck
 * connect to an unreachable host — a bare AbortController would hang forever.
 * The timeout budget covers the ENTIRE chain, not each hop. */
export async function fetchWithTimeout(url: string): Promise<RedirectResult> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      try {
        controller.abort();
      } catch {
        /* best-effort cancel */
      }
      reject(new Error(`URL preview timed out after ${FETCH_TIMEOUT_MS}ms`));
    }, FETCH_TIMEOUT_MS);
  });
  try {
    return await Promise.race([
      followWithRedirects(url, controller.signal),
      timeout,
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/**
 * Fetch the URL and extract a structured preview. Returns null on any
 * failure — invalid URL, network error, timeout, non-200, non-HTML
 * content type, or parse error. Never throws.
 */
export async function fetchUrlPreview(url: string): Promise<UrlPreview | null> {
  // Validate the URL first so we don't waste a network round-trip on
  // garbage input.
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  // Only http(s). file://, content://, javascript: etc. are out.
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return null;
  }
  // SSRF guard — see isBlockedHost JSDoc for the threat model. Extract the
  // host from the raw URL rather than `parsed.hostname`: RN's URL does not
  // canonicalize numeric/hex/octal IP encodings or bracketed IPv6 literals.
  if (isBlockedHost(extractHost(url) ?? parsed.hostname)) {
    return null;
  }

  let response: Response;
  try {
    ({ response } = await fetchWithTimeout(url));
  } catch {
    return null;
  }
  if (!response.ok) return null;

  const contentType = response.headers.get("content-type") ?? "";
  if (!/text\/html|application\/xhtml\+xml/i.test(contentType)) {
    return null;
  }

  let body: string;
  try {
    body = await response.text();
  } catch {
    return null;
  }
  // Cap memory: many sites serve multi-MB HTML; the head we care about
  // sits in the first few KB.
  const html = body.length > MAX_BODY_CHARS ? body.slice(0, MAX_BODY_CHARS) : body;

  try {
    const ogTitle = metaContent(html, "og:title");
    const twitterTitle = metaContent(html, "twitter:title");
    const titleTag = firstMatch(html, /<title[^>]*>([^]*?)<\/title>/i);
    const title = ogTitle || twitterTitle || titleTag;

    const ogDesc = metaContent(html, "og:description");
    const twitterDesc = metaContent(html, "twitter:description");
    const metaDesc = metaContent(html, "description");
    const description =
      ogDesc || twitterDesc || metaDesc || firstParagraph(html);

    const ogSite = metaContent(html, "og:site_name");
    const siteName = ogSite || parsed.hostname;

    // Sanity check: if we got nothing structural, treat the page as
    // unparseable. Reflexive 200-with-empty-body responses fall here.
    if (!title && !description) return null;

    return { title, description, siteName, contentType };
  } catch {
    return null;
  }
}
