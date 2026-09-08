/**
 * One-time explainer gate for the retrospective Ask feature's remote-backend
 * disclosure (Task 8 of the retrospective-query plan).
 *
 * Every other LLM call in this app sends one note the user just chose to
 * send (Capture's enrich, a single share-received item). Ask is different:
 * it bundles up to MAX_NOTES past notes — including ones never chosen for
 * enrichment — and sends them to whichever provider is configured. That
 * escalation in what leaves the device is why this dialog exists, and why it
 * is gated on the resolved provider rather than shown unconditionally: a
 * local/loopback backend (Relais, a LAN OmniRoute) never sends the bundle
 * off-device, so there is nothing to disclose.
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
