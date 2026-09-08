import { beforeEach, describe, expect, it, vi } from "vitest";

const _store = new Map<string, string>();

vi.mock("@react-native-async-storage/async-storage", () => ({
  default: {
    getItem: vi.fn(async (k: string) => _store.get(k) ?? null),
    setItem: vi.fn(async (k: string, v: string) => {
      _store.set(k, v);
    }),
  },
}));

function makeSettings(overrides: Partial<{ activeProviderId: string; baseUrl: string }> = {}) {
  const activeProviderId = overrides.activeProviderId ?? "omniroute";
  return {
    llmProviders: [
      {
        id: activeProviderId,
        label: "Test provider",
        baseUrl: overrides.baseUrl ?? "https://api.example.com",
        model: "gpt-4o-mini",
        visionModel: "",
        preset: null,
      },
    ],
    activeProviderId,
    enhanceProviderId: null,
  };
}

const getSettingsMock = vi.fn();
vi.mock("./settings", () => ({
  getSettings: (...args: unknown[]) => getSettingsMock(...args),
}));

import {
  hasSeenAskExplainer,
  markAskExplainerSeen,
  shouldShowAskExplainer,
} from "./askExplainer";

beforeEach(() => {
  _store.clear();
  vi.clearAllMocks();
});

describe("hasSeenAskExplainer / markAskExplainerSeen", () => {
  it("is unseen until marked", async () => {
    expect(await hasSeenAskExplainer()).toBe(false);
    await markAskExplainerSeen();
    expect(await hasSeenAskExplainer()).toBe(true);
  });
});

describe("shouldShowAskExplainer", () => {
  it("shows for a remote (https) provider that hasn't been seen", async () => {
    getSettingsMock.mockResolvedValue(makeSettings({ baseUrl: "https://api.example.com" }));
    expect(await shouldShowAskExplainer()).toBe(true);
  });

  it("does not show for a local/loopback provider", async () => {
    getSettingsMock.mockResolvedValue(makeSettings({ baseUrl: "http://127.0.0.1:8080" }));
    expect(await shouldShowAskExplainer()).toBe(false);
  });

  it("does not show once the explainer has been permanently dismissed", async () => {
    getSettingsMock.mockResolvedValue(makeSettings({ baseUrl: "https://api.example.com" }));
    await markAskExplainerSeen();
    expect(await shouldShowAskExplainer()).toBe(false);
  });
});
