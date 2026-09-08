/**
 * One-time explainer gate for the retrospective Ask feature's remote-backend
 * disclosure (Task 8 of the retrospective-query plan).
 *
 * Every other LLM call in this app sends one note the user just chose to
 * send (Capture's enrich, a single share-received item). Ask is different:
 * it bundles up to MAX_NOTES past notes — including ones never chosen for
 * enrichment — and sends them to whichever provider is configured. That
 * escalation in what leaves the device is why this dialog exists, and why it
 * is gated on the resolved provider: for a local/loopback or tailnet backend
 * (Relais, a LAN or Tailscale-reachable OmniRoute) the bundle stays on the
 * user's own machines/network rather than reaching a third-party provider,
 * so there is nothing to disclose.
 *
 * Classification is `providerReadiness.ts`'s isLocalProvider (built on
 * `netAllowlist.ts`'s isLocalNetworkUrl) — the same UX-locality predicate
 * that widened to include Tailscale's CGNAT range for exactly this class of
 * decision. That module's #176-reviewed split treats a tailnet as "the
 * user's own network" ONLY for consumers with no credential/security
 * consequence for a wrong answer (a timeout tier, a reachability hint, and
 * now this dismissible disclosure) — never for the credential gate
 * (isAllowedPlaintextHost/isCredentialSafeUrl) that decides whether a Bearer
 * key may travel in the clear. A wrong answer here costs an extra or a
 * skipped notice, never a leaked key, so reusing the wider predicate is the
 * same trade this codebase already made deliberately, not a new one.
 */
import AsyncStorage from "@react-native-async-storage/async-storage";

import { getSettings } from "./settings";
import { resolveEnhanceProvider } from "./llmProviders";
import { isLocalProvider } from "./providerReadiness";

const SEEN_KEY = "carnet:askExplainerSeen:v1";

/** True once the user has dismissed the explainer with "Don't show again". */
export async function hasSeenAskExplainer(): Promise<boolean> {
  return (await AsyncStorage.getItem(SEEN_KEY)) !== null;
}

/** Persists the "Don't show again" choice. Permanent — there is no UI to
 * re-arm it, matching settings.ts's migration-banner precedent. */
export async function markAskExplainerSeen(): Promise<void> {
  await AsyncStorage.setItem(SEEN_KEY, "1");
}

/**
 * True when the first-press explainer must be shown before navigating to
 * Ask: the provider that will actually serve the question (the same
 * resolution `dispatcher.ts`'s askVault uses) is not local/loopback, AND the
 * user hasn't permanently dismissed the explainer already.
 */
export async function shouldShowAskExplainer(): Promise<boolean> {
  if (await hasSeenAskExplainer()) return false;
  const settings = await getSettings();
  const provider = resolveEnhanceProvider(
    settings.llmProviders,
    settings.activeProviderId,
    settings.enhanceProviderId,
  );
  return !isLocalProvider(provider);
}
