// @vitest-environment jsdom
//
// Screen smoke test for ShareReceive (pattern: HomeScreen.test.tsx).
// Pins the load-bearing wiring the 2026-07-16 audit flagged as untested:
//   - the SECURITY fix: a degraded (LLM-unreachable) save must pass the stub
//     body through sanitizeMarkdown — a shared dataviewjs/Templater payload
//     must never reach writeIdea raw (enrichSanitize is imported REAL here;
//     that wiring is exactly what's under test);
//   - the double-goBack fix: cancel() resets the share context and pops once;
//     the "opened empty" bail effect must not fire a second pop;
//   - the golden text-share save path.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { PaperProvider } from "react-native-paper";

import { carnetLight } from "../lib/theme";

// Mutable share-intent context the component reads through the mocked hook.
type MockShareIntent = {
  text?: string | null;
  webUrl?: string | null;
  files?: unknown[] | null;
} | null;
const shareCtx: {
  shareIntent: MockShareIntent;
  hasShareIntent: boolean;
  resetShareIntent: () => void;
} = {
  shareIntent: null,
  hasShareIntent: false,
  resetShareIntent: () => {
    shareCtx.shareIntent = null;
    shareCtx.hasShareIntent = false;
  },
};
vi.mock("expo-share-intent", () => ({
  useShareIntentContext: () => shareCtx,
}));

// writer imports expo-file-system at module scope — never load the real one.
// The pure helpers get simple real-shaped stand-ins.
vi.mock("../lib/writer", () => ({
  writeIdea: vi.fn(async (slug: string) => ({
    filepath: `file:///v/Ideas/${slug}.md`,
  })),
  writeBinary: vi.fn(async (subdir: string, name: string) => ({
    filepath: `file:///v/${subdir}/${name}`,
    finalName: name,
  })),
  updateNote: vi.fn(async () => {}),
  extFromMime: vi.fn(() => "txt"),
  injectImageEmbed: vi.fn((md: string) => md),
  slugify: vi.fn((s: string) =>
    s
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, ""),
  ),
}));

vi.mock("../lib/dispatcher", () => ({
  enrichSharedImage: vi.fn(),
  enrichSharedLink: vi.fn(),
  autoTranscribeIfEnabled: vi.fn(async () => null),
}));

// NOTE: ../lib/enrichSanitize is deliberately NOT mocked.

vi.mock("../lib/llmClient", () => ({
  assertBase64UnderLimit: vi.fn(),
  MAX_SHARED_IMAGE_BYTES: 8 * 1024 * 1024,
}));

// shareHelpers imports expo-file-system too; pure helpers reimplemented.
vi.mock("../lib/shareHelpers", () => ({
  readShareFileAsBase64: vi.fn(),
  shareFileReadUri: vi.fn(
    (f: { path: string; contentUri?: string | null }) =>
      f.contentUri || f.path,
  ),
  sanitizeShareString: vi.fn((v: string) => v.replace(/[\r\n]/g, " ")),
  yamlQuote: vi.fn((v: string) => JSON.stringify(v.replace(/[\r\n]/g, " "))),
  MAX_SAFE_SHARE_BYTES: 200 * 1024 * 1024,
  BASE64_EXPANSION: 1.4,
}));

vi.mock("../lib/storage", () => ({ recordCapture: vi.fn(async () => {}) }));

// settings.ts pulls in expo-secure-store at module scope, which chokes under
// vitest (__DEV__ undefined) — never load the real one. Empty llmProviders
// keeps the providerLabel effect a no-op (falls back to
// UNKNOWN_PROVIDER_LABEL), same as CaptureScreen.test.tsx's pattern.
vi.mock("../lib/settings", () => ({
  getSettings: vi.fn(async () => ({ activeProviderId: "omniroute" })),
}));

// Pulls in the native speech stack — irrelevant to this screen's save wiring.
vi.mock("../voice/VoiceButton", () => ({ VoiceButton: () => null }));

import ShareReceiveScreen from "./ShareReceiveScreen";
import { enrichSharedLink } from "../lib/dispatcher";
import { writeIdea } from "../lib/writer";
import { getSettings } from "../lib/settings";
import { recordCapture } from "../lib/storage";

type ScreenProps = Parameters<typeof ShareReceiveScreen>[0];

function makeNavigation() {
  return {
    goBack: vi.fn(),
    navigate: vi.fn(),
    setOptions: vi.fn(),
    addListener: vi.fn(() => vi.fn()),
  };
}

function renderScreen() {
  const navigation = makeNavigation();
  const ui = (
    <PaperProvider theme={carnetLight}>
      <ShareReceiveScreen
        navigation={navigation as unknown as ScreenProps["navigation"]}
        route={{ key: "s", name: "ShareReceive" } as ScreenProps["route"]}
      />
    </PaperProvider>
  );
  const utils = render(ui);
  return { navigation, ui, ...utils };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getSettings).mockReset();
  vi.mocked(getSettings).mockResolvedValue({ activeProviderId: "omniroute", captureFolderPath: "" } as Awaited<ReturnType<typeof getSettings>>);
  vi.spyOn(console, "warn").mockImplementation(() => {});
  shareCtx.shareIntent = { text: "a shared thought", webUrl: null, files: null };
  shareCtx.hasShareIntent = true;
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("ShareReceiveScreen", () => {
  it("saves an enriched text share and lands on the saved state", async () => {
    vi.mocked(enrichSharedLink).mockResolvedValue({
      markdown: "---\nkind: shared-text\ntags: [shared]\n---\n# Enriched\n\nbody\n",
    } as Awaited<ReturnType<typeof enrichSharedLink>>);
    renderScreen();

    fireEvent.click(await screen.findByText("Save to vault"));

    await waitFor(() => expect(writeIdea).toHaveBeenCalledTimes(1));
    expect(vi.mocked(writeIdea).mock.calls[0][1]).toContain("# Enriched");
    expect(await screen.findByText("Done")).toBeTruthy();
  });

  it("pins a share's note and recents entry to its starting Work vault", async () => {
    vi.mocked(getSettings).mockResolvedValue({
      activeProviderId: "omniroute",
      captureFolderPath: "file:///work",
      vaultProfiles: [
        { id: "default", name: "Personal", rootUri: "file:///personal", createdAt: 0 },
        { id: "work", name: "Work", rootUri: "file:///work", createdAt: 1 },
      ],
      activeVaultProfileId: "work",
    } as Awaited<ReturnType<typeof getSettings>>);
    vi.mocked(enrichSharedLink).mockResolvedValue({
      markdown: "---\nkind: shared-text\n---\n# Work share\n\nbody\n",
    } as Awaited<ReturnType<typeof enrichSharedLink>>);
    renderScreen();

    fireEvent.click(await screen.findByText("Save to vault"));

    await waitFor(() => expect(writeIdea).toHaveBeenCalledTimes(1));
    expect(vi.mocked(writeIdea).mock.calls[0][2]).toEqual(expect.objectContaining({ uri: "file:///work" }));
    expect(recordCapture).toHaveBeenCalledWith(expect.anything(), "work");
  });

  it("SECURITY: a degraded save sanitizes hostile share text before it reaches the vault", async () => {
    shareCtx.shareIntent = {
      text: "look at this\n```dataviewjs\napp.vault.evil()\n```\nand <%tp.file.include('x')%> tail",
      webUrl: null,
      files: null,
    };
    vi.mocked(enrichSharedLink).mockRejectedValue(
      new Error("OmniRoute unreachable"),
    );
    renderScreen();

    fireEvent.click(await screen.findByText("Save to vault"));
    await waitFor(() => expect(writeIdea).toHaveBeenCalledTimes(1));

    const body = vi.mocked(writeIdea).mock.calls[0][1];
    // The stub still saves the share (fail-open)…
    expect(body).toContain("## Excerpt");
    // …but the executable payloads must be neutralized by sanitizeMarkdown.
    expect(body).not.toContain("```dataviewjs");
    expect(body).not.toContain("<%");
  });

  it("cancel resets the share context and pops exactly once", async () => {
    const { navigation, ui, rerender } = renderScreen();
    fireEvent.click(await screen.findByText("Cancel"));
    expect(shareCtx.shareIntent).toBeNull();
    // The context nulling re-renders the still-mounted screen — the
    // opened-empty bail effect must NOT fire a second goBack.
    rerender(ui);
    await waitFor(() => expect(navigation.goBack).toHaveBeenCalledTimes(1));
  });

  it("bails with a single goBack when opened with no share (deep-link mishap)", async () => {
    shareCtx.shareIntent = null;
    shareCtx.hasShareIntent = false;
    const { navigation } = renderScreen();
    await waitFor(() => expect(navigation.goBack).toHaveBeenCalledTimes(1));
  });

  it("names the active provider (not a hardcoded default) in the saving-phase label", async () => {
    vi.mocked(getSettings).mockResolvedValueOnce({
      activeProviderId: "groq",
      llmProviders: [
        {
          id: "groq",
          label: "Groq",
          baseUrl: "https://api.groq.com/openai",
          model: "llama-3.3-70b",
          visionModel: "",
          preset: "groq",
        },
      ],
    } as Awaited<ReturnType<typeof getSettings>>);
    let resolveEnrich!: (v: Awaited<ReturnType<typeof enrichSharedLink>>) => void;
    vi.mocked(enrichSharedLink).mockReturnValueOnce(
      new Promise((res) => {
        resolveEnrich = res;
      }),
    );

    renderScreen();
    await screen.findByText("Save to vault");
    // Let the mount-time getSettings().then() (which resolves providerLabel)
    // settle before clicking — otherwise save() reads the still-default
    // UNKNOWN_PROVIDER_LABEL from the same render tick as the click.
    await act(async () => {
      await Promise.resolve();
    });
    fireEvent.click(screen.getByText("Save to vault"));

    expect(await screen.findByText("Groq is enriching + saving…")).toBeTruthy();

    resolveEnrich({
      markdown: "---\nkind: shared-text\n---\n# Enriched\n\nbody\n",
    } as Awaited<ReturnType<typeof enrichSharedLink>>);
    await waitFor(() => expect(writeIdea).toHaveBeenCalledTimes(1));
  });
});
