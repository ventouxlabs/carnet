/**
 * Shared plaintext-host allowlist for the credentialed backend clients
 * (OmniRoute + Karakeep). A Bearer API key must NEVER travel over cleartext
 * `http://` to an arbitrary host.
 *
 * HTTPS is always allowed. Plain `http://` is allowed ONLY for a fixed set of
 * local / LAN hosts where the dev + self-hosted loop legitimately runs:
 *   - `localhost` / `127.0.0.1` (loopback)
 *   - `10.0.0.0/8`   (RFC1918 — host-on-LAN dev loop)
 *   - `192.168.0.0/16` (RFC1918 — a user may run OmniRoute at 192.168.x)
 *   - `172.16.0.0/12`  (RFC1918)
 *
 * The previous implementation used a right-unanchored prefix regex
 * (`/^http:\/\/(localhost|127\.0\.0\.1|10\.)/`). That let `http://10.evil.com`,
 * `http://localhost.attacker.com`, and `http://127.0.0.1.attacker.com` through
 * — leaking the Bearer key to an attacker host. Exact hostname parsing via
 * `new URL()` closes that bypass.
 *
 * This module exports TWO predicates over the same host classification
 * question, and callers must pick the right one deliberately (issue #176's
 * security review split them apart — see each function's own doc):
 *   - {@link isAllowedPlaintextHost} (and everything built on it —
 *     {@link isCredentialSafeUrl}, llmGuards.ts's assertHttpsOrLocal) is the
 *     CREDENTIAL GATE: it decides whether a Bearer key may travel in the
 *     clear. It stays narrow (loopback + RFC1918 only) on purpose.
 *   - {@link isLocalNetworkUrl} is a UX-locality predicate: "does this look
 *     like my own network?", consumed by call sites that carry no security
 *     consequence for a wrong answer (a timeout tier, a readiness hint, a
 *     keyless-provider banner). It is intentionally WIDER than the gate.
 */

/** True when `url`'s host is one of the allowed cleartext local/LAN hosts —
 * the CREDENTIAL GATE. Consulted only for `http://` URLs — see
 * {@link isCredentialSafeUrl}. Every consumer of this function (directly or
 * via isCredentialSafeUrl/assertHttpsOrLocal) decides whether a Bearer API
 * key is allowed to travel over this URL:
 *   - llmClient.ts's isCredentialSafeUrl → assertHttpsOrLocal (llmGuards.ts)
 *     → executeChat/assertVisionReady (every content-bearing enrichment call)
 *   - karakeep.ts's assertHttpsOrLocal (every Karakeep call — all
 *     content-bearing, no probe-only path exists there)
 *
 * Deliberately NOT widened to Tailscale's 100.64.0.0/10 CGNAT range — see
 * {@link isLocalNetworkUrl}'s doc for why that widening is UX-only. */
export function isAllowedPlaintextHost(url: string): boolean {
  try {
    const { hostname } = new URL(url);
    if (hostname === "localhost" || hostname === "127.0.0.1") return true;
    const parts = hostname.split(".");
    const allNumeric =
      parts.length === 4 && parts.every((p) => /^\d+$/.test(p));
    if (!allNumeric) return false;
    // 10.0.0.0/8
    if (parts[0] === "10") return true;
    // 192.168.0.0/16
    if (parts[0] === "192" && parts[1] === "168") return true;
    // 172.16.0.0/12 — second octet 16-31 INCLUSIVE. The bounds matter:
    // 172.15.x.x and 172.32.x.x are public address space, so a looser
    // `parts[0] === "172"` check would permit sending a plaintext API key to
    // the internet.
    if (parts[0] === "172") {
      const second = Number(parts[1]);
      if (second >= 16 && second <= 31) return true;
    }
    return false;
  } catch {
    return false;
  }
}

/** True when `url` points at a loopback/RFC1918 LAN host (everything
 * {@link isAllowedPlaintextHost} allows) OR a Tailscale CGNAT address
 * (`100.64.0.0/10`), whatever the URL's scheme — the UX-LOCALITY predicate,
 * named for call sites that ask "does this endpoint live on my own network?"
 * rather than "is a Bearer key safe to send here?". Consumers:
 *   - llmHttp.ts's resolveEnrichmentTimeoutMs — a local/tailnet endpoint gets
 *     the generous on-device-inference timeout tier instead of the
 *     fast-fail-for-the-offline-queue cloud one.
 *   - providerReadiness.ts's isLocalProvider — which providers get the
 *     "make sure it's running" reachability hint vs. always-on cloud
 *     treatment. In turn consumed (transitively, still via isLocalProvider)
 *     by askExplainer.ts's shouldShowAskExplainer, which skips the
 *     retrospective-query privacy disclosure for a local/tailnet backend —
 *     no credential is at stake there either, just whether a dismissible
 *     notice shows.
 *   - dispatcher.ts's assertVisionCredentialPresent — whether a missing API
 *     key gets an advisory "usually requires one" banner.
 *
 * NONE of these consumers gate whether a credential is transmitted — a wrong
 * answer here costs a mistimed timeout tier or a banner that doesn't fire,
 * never a leaked key. That is why this is deliberately WIDER than the
 * credential gate: a self-hosted Relais/OmniRoute reachable over a Tailscale
 * tailnet (100.64.0.0/10 is the address space `tailscaled` issues) is just as
 * much "my own network" for UX purposes as a 192.168.x LAN box, even though
 * the #176 security review explicitly declined to widen the CREDENTIAL gate
 * to the same range (a tailnet is not the same trust boundary as a
 * physically-local LAN — see isAllowedPlaintextHost's doc). Bounds mirror
 * that function's 172.16/12 check: first octet 100, second octet 64-127
 * inclusive (100.64.0.0 - 100.127.255.255). */
export function isLocalNetworkUrl(url: string): boolean {
  if (isAllowedPlaintextHost(url)) return true;
  try {
    const { hostname } = new URL(url);
    const parts = hostname.split(".");
    const allNumeric =
      parts.length === 4 && parts.every((p) => /^\d+$/.test(p));
    if (!allNumeric) return false;
    if (parts[0] !== "100") return false;
    const second = Number(parts[1]);
    return second >= 64 && second <= 127;
  } catch {
    return false;
  }
}

/** True when `url` is safe to send a Bearer API key to: any `https://` URL, or
 * an `http://` URL whose host is in the local/LAN allowlist. Everything else
 * (other schemes, unparseable URLs, plain http to a public host) is false.
 *
 * #176: "https" here means "trusted by whatever the platform's TLS trust
 * store resolves to" — since withNetworkSecurityConfig.js opted the app into
 * trusting Android's USER CA store as well as the system one, that no longer
 * implies a chain to a public CA. A cert the device user installed (for a
 * self-signed Relais, or by anything else with access to the user CA store)
 * satisfies this check too. See docs/self-signed-certs.md. */
export function isCredentialSafeUrl(url: string): boolean {
  try {
    const { protocol } = new URL(url);
    if (protocol === "https:") return true;
    if (protocol === "http:") return isAllowedPlaintextHost(url);
    return false;
  } catch {
    return false;
  }
}
