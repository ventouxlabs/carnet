// @vitest-environment jsdom
//
// Screen smoke test for Home (pattern: see TagBrowserScreen.test.tsx).
// Covers the redesign's load-bearing wiring: recents as cards with the
// note-index metadata join (tags/pending stamps), card → detail navigation,
// and the capture FAB (tap = straight to Idea; chevron sheet for the other
// modes). The header sync dot renders via navigation.setOptions →
// headerRight, outside this component tree — its presence is asserted via
// the setOptions call.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { PaperProvider } from "react-native-paper";

import { carnetLight } from "../lib/theme";
import type { CaptureEntry } from "../lib/storage";

const RECENTS: CaptureEntry[] = [
  {
    id: "r1",
    mode: "idea",
    title: "Jack's Baseball Team",
    filepath: "file:///v/Ideas/jacks-baseball-team.md",
    createdAt: Date.now() - 60_000,
  },
  {
    id: "r2",
    mode: "journal",
    title: "A journal day",
    filepath: "file:///v/Journal/2026-07-08.md",
    createdAt: Date.now() - 3_600_000,
  },
];

vi.mock("../lib/storage", () => ({
  getRecentCaptures: vi.fn(async () => RECENTS),
  removeManyFromHistory: vi.fn(async () => {}),
}));

vi.mock("../lib/settings", () => ({
  getSettings: vi.fn(async () => ({ captureFolderPath: "" })),
}));
vi.mock("../lib/vaultRoot", () => ({
  resolveContextRoot: vi.fn((context: { rootUri: string }) => ({ uri: context.rootUri, fs: {} })),
}));

// writer.ts imports expo-file-system at module scope — never load the real one.
vi.mock("../lib/writer", () => ({
  moveToArchive: vi.fn(async () => {}),
  listNoteFiles: vi.fn(async () => []),
  listSyncConflictFiles: vi.fn(async () => []),
}));

vi.mock("../lib/vault", () => ({
  loadCachedNoteIndex: vi.fn(async () => ({
    builtAt: 1,
    notes: [
      {
        uri: "file:///v/Ideas/jacks-baseball-team.md",
        subdir: "Ideas",
        title: "Jack's Baseball Team",
        createdOrDate: 1,
        tags: ["sports"],
        mode: "idea",
        excerpt: "Jack made the team",
        status: "pending-enrich",
      },
    ],
  })),
  refreshNoteIndex: vi.fn(async () => ({ builtAt: 2, notes: [] })),
  resolveNoteEntry: vi.fn(async () => null),
  scanPossibleSafStaleTails: vi.fn(async () => ({
    candidates: [],
    scanned: 0,
    unreadable: 0,
  })),
}));
vi.mock("../lib/vaultRefreshService", () => ({ refreshActiveVault: vi.fn(async () => {}) }));

vi.mock("../lib/syncStatus", () => ({
  getSyncStatus: vi.fn(async () => ({
    state: "idle",
    pending: 0,
    failed: 0,
    detail: "All captures are written to the vault and enriched.",
  })),
}));

vi.mock("../lib/queue", () => ({
  drainQueue: vi.fn(async () => {}),
  listQueueRows: vi.fn(async () => []),
  MAX_AUTO_RETRY_ATTEMPTS: 10,
}));

// Pending Karakeep exports (host-unreachable retry queue) — default: empty.
// The captured subscriber lets tests simulate a background drain mutating
// the queue while Home is focused (the stale-banner fix under test).
const pendingSyncListeners = new Set<() => void>();
vi.mock("../lib/pendingSync", () => ({
  getPendingExportCount: vi.fn(async () => 0),
  subscribePendingSyncChanges: vi.fn((cb: () => void) => {
    pendingSyncListeners.add(cb);
    return () => pendingSyncListeners.delete(cb);
  }),
}));
vi.mock("../lib/pendingSyncRunner", () => ({
  drainPendingKarakeepExports: vi.fn(async () => {}),
}));

// Pulls in VoiceButton's native speech stack — irrelevant to Home's layout.
vi.mock("../voice/VoiceReadinessBanner", () => ({
  VoiceReadinessBanner: () => null,
}));

// Mocked for two reasons: the real module's breach warn can fire as noise on
// a slow CI collect phase (>3s between module eval and first render), and
// mocking lets the wiring test below pin that Home actually reports.
vi.mock("../lib/startupTiming", () => ({ reportColdStart: vi.fn() }));

import HomeScreen from "./HomeScreen";
import { getRecentCaptures } from "../lib/storage";
import { getSettings } from "../lib/settings";
import { getPendingExportCount } from "../lib/pendingSync";
import { drainPendingKarakeepExports } from "../lib/pendingSyncRunner";
import { listNoteFiles, listSyncConflictFiles } from "../lib/writer";
import { reportColdStart } from "../lib/startupTiming";
import { refreshActiveVault } from "../lib/vaultRefreshService";
import { resolveNoteEntry, scanPossibleSafStaleTails } from "../lib/vault";

type ScreenProps = Parameters<typeof HomeScreen>[0];

function makeNavigation() {
  const listeners = new Map<string, () => void>();
  return {
    setOptions: vi.fn(),
    navigate: vi.fn(),
    addListener: vi.fn((event: string, listener: () => void) => {
      listeners.set(event, listener);
      return () => listeners.delete(event);
    }),
    goBack: vi.fn(),
    emit: (event: string) => listeners.get(event)?.(),
  };
}

function renderScreen() {
  const navigation = makeNavigation();
  render(
    <PaperProvider theme={carnetLight}>
      <HomeScreen
        navigation={navigation as unknown as ScreenProps["navigation"]}
        route={{ key: "h", name: "Home" } as ScreenProps["route"]}
      />
    </PaperProvider>,
  );
  return { navigation };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getSettings).mockResolvedValue({ captureFolderPath: "" } as Awaited<ReturnType<typeof getSettings>>);
  pendingSyncListeners.clear();
});

afterEach(cleanup);

describe("HomeScreen", () => {
  it("renders recents as cards with excerpt, tag and pending stamps joined from the index", async () => {
    renderScreen();
    expect(await screen.findByText("Jack's Baseball Team")).toBeTruthy();
    expect(screen.getByText("A journal day")).toBeTruthy();
    expect(screen.getByText("Jack made the team")).toBeTruthy();
    expect(screen.getByText("#sports")).toBeTruthy();
    expect(screen.getByText("pending")).toBeTruthy();
    // The second note has no index row — card still renders, just plainer.
    expect(screen.getByText("Journal")).toBeTruthy();
  });

  it("schedules a background vault reconciliation on Home focus", async () => {
    renderScreen();
    await screen.findByText("Jack's Baseball Team");
    expect(refreshActiveVault).toHaveBeenCalledTimes(1);
  });

  it("shows the empty state pointing at the FAB when nothing is captured", async () => {
    vi.mocked(getRecentCaptures).mockResolvedValueOnce([]);
    renderScreen();
    expect(await screen.findByText("Nothing captured yet")).toBeTruthy();
    expect(screen.getByText("Tap Capture below to write your first note.")).toBeTruthy();
  });

  it("reads only the active profile's recents", async () => {
    vi.mocked(getSettings).mockResolvedValue({
      captureFolderPath: "file:///work",
      vaultProfiles: [
        { id: "default", name: "Personal", rootUri: "file:///personal", createdAt: 0 },
        { id: "work", name: "Work", rootUri: "file:///work", createdAt: 1 },
      ],
      activeVaultProfileId: "work",
    } as Awaited<ReturnType<typeof getSettings>>);
    renderScreen();
    await screen.findByText("Jack's Baseball Team");
    expect(getRecentCaptures).toHaveBeenCalledWith("work");
  });

  it("opens a card into RecentDetail with its entry", async () => {
    const { navigation } = renderScreen();
    fireEvent.click(await screen.findByText("Jack's Baseball Team"));
    await waitFor(() =>
      expect(navigation.navigate).toHaveBeenCalledWith("RecentDetail", {
        entry: expect.objectContaining({ id: "r1" }),
        vaultContext: { profileId: "default", rootUri: "" },
      }),
    );
  });

  it("FAB tap goes straight into Idea capture; the chevron sheet reaches the other modes", async () => {
    const { navigation } = renderScreen();
    await screen.findByText("Jack's Baseball Team");

    fireEvent.click(
      screen.getByLabelText("Capture an idea (long-press for more modes)"),
    );
    expect(navigation.navigate).toHaveBeenCalledWith("Capture", { mode: "idea" });

    fireEvent.click(screen.getByLabelText("More capture modes"));
    fireEvent.click(await screen.findByText("Photo"));
    await waitFor(() =>
      expect(navigation.navigate).toHaveBeenCalledWith("PhotoCapture"),
    );
  });

  it("the chevron sheet offers a Note capture", async () => {
    const { navigation } = renderScreen();
    await screen.findByText("Jack's Baseball Team");
    fireEvent.click(screen.getByLabelText("More capture modes"));
    fireEvent.click(await screen.findByText("A task list or working notes"));
    await waitFor(() =>
      expect(navigation.navigate).toHaveBeenCalledWith("Capture", { mode: "note" }),
    );
  });

  it("shows no Karakeep banner when nothing is waiting", async () => {
    renderScreen();
    await screen.findByText("Jack's Baseball Team");
    expect(screen.queryByText(/waiting for Karakeep/)).toBeNull();
  });

  it("shows the pending-export banner with a Retry that drains the queue", async () => {
    vi.mocked(getPendingExportCount)
      .mockResolvedValueOnce(2) // initial refresh
      .mockResolvedValue(0); // re-read after the retry drain
    renderScreen();
    expect(
      await screen.findByText(
        "2 exports waiting for Karakeep — will send when the server is reachable",
      ),
    ).toBeTruthy();

    fireEvent.click(screen.getByText("Retry"));
    await waitFor(() =>
      expect(drainPendingKarakeepExports).toHaveBeenCalledTimes(1),
    );
    // Everything drained — the banner clears.
    await waitFor(() =>
      expect(screen.queryByText(/waiting for Karakeep/)).toBeNull(),
    );
  });

  it("reports cold-start completion on first mount", async () => {
    renderScreen();
    await screen.findByText("Jack's Baseball Team");
    expect(reportColdStart).toHaveBeenCalled();
  });

  it("updates the pending-Karakeep banner when a background drain mutates the queue", async () => {
    // Focus-time read sees 1 waiting export…
    vi.mocked(getPendingExportCount).mockResolvedValue(1);
    renderScreen();
    expect(
      await screen.findByText(
        "1 export waiting for Karakeep — will send when the server is reachable",
      ),
    ).toBeTruthy();

    // …then the App.tsx foreground drain empties the queue while Home stays
    // focused. The mutation ping must clear the banner without a refocus.
    vi.mocked(getPendingExportCount).mockResolvedValue(0);
    expect(pendingSyncListeners.size).toBeGreaterThan(0);
    for (const cb of pendingSyncListeners) cb();
    await waitFor(() =>
      expect(screen.queryByText(/waiting for Karakeep/)).toBeNull(),
    );
  });

  it("shows no conflict banner when the vault has no sync conflicts", async () => {
    renderScreen();
    await screen.findByText("Jack's Baseball Team");
    expect(screen.queryByText(/sync conflict/)).toBeNull();
  });

  it("scans historical SAF rewrites only when asked and opens a candidate for manual review", async () => {
    const { navigation } = renderScreen();
    await screen.findByText("Jack's Baseball Team");
    expect(scanPossibleSafStaleTails).not.toHaveBeenCalled();

    vi.mocked(scanPossibleSafStaleTails).mockResolvedValueOnce({
      candidates: [
        {
          uri: "file:///v/Ideas/possible-tail.md",
          name: "possible-tail.md",
          subdir: "Ideas",
        },
      ],
      scanned: 1,
      unreadable: 0,
    });
    vi.mocked(resolveNoteEntry).mockResolvedValueOnce({
      id: "tail",
      mode: "idea",
      title: "Possible tail",
      filepath: "file:///v/Ideas/possible-tail.md",
      createdAt: 0,
    });

    fireEvent.click(screen.getByText("Scan"));
    expect(await screen.findByText("Possible leftover text")).toBeTruthy();
    expect(screen.getByText("Ideas/possible-tail.md")).toBeTruthy();
    expect(screen.queryByText("distinctive leftover fragment")).toBeNull();

    fireEvent.click(screen.getByText("Open note"));
    await waitFor(() =>
      expect(navigation.navigate).toHaveBeenCalledWith("RecentDetail", {
        entry: expect.objectContaining({ id: "tail" }),
        vaultContext: { profileId: "default", rootUri: "" },
      }),
    );
  });

  it("clears completed SAF-tail results after a profile switch", async () => {
    const { navigation } = renderScreen();
    await screen.findByText("Jack's Baseball Team");
    vi.mocked(scanPossibleSafStaleTails).mockResolvedValueOnce({
      candidates: [{ uri: "file:///v/Ideas/tail.md", name: "tail.md", subdir: "Ideas" }],
      scanned: 1,
      unreadable: 0,
    });

    fireEvent.click(screen.getByText("Scan"));
    expect(await screen.findByText("Ideas/tail.md")).toBeTruthy();

    vi.mocked(getSettings).mockResolvedValue({
      captureFolderPath: "file:///work",
      vaultProfiles: [
        { id: "default", name: "Personal", rootUri: "file:///personal", createdAt: 0 },
        { id: "work", name: "Work", rootUri: "file:///work", createdAt: 1 },
      ],
      activeVaultProfileId: "work",
    } as Awaited<ReturnType<typeof getSettings>>);
    navigation.emit("focus");

    await waitFor(() => expect(screen.queryByText("Ideas/tail.md")).toBeNull());
    expect(screen.getByText("Check older SAF rewrites for possible leftover text (read-only)")).toBeTruthy();
  });

  it("does not open a tail candidate after its vault changes during note resolution", async () => {
    const { navigation } = renderScreen();
    await screen.findByText("Jack's Baseball Team");
    vi.mocked(scanPossibleSafStaleTails).mockResolvedValueOnce({
      candidates: [{ uri: "file:///v/Ideas/tail.md", name: "tail.md", subdir: "Ideas" }],
      scanned: 1,
      unreadable: 0,
    });
    let finishResolve!: (entry: CaptureEntry | null) => void;
    vi.mocked(resolveNoteEntry).mockImplementationOnce(
      () => new Promise<CaptureEntry | null>((resolve) => { finishResolve = resolve; }),
    );

    fireEvent.click(screen.getByText("Scan"));
    fireEvent.click(await screen.findByText("Open note"));
    await waitFor(() => expect(resolveNoteEntry).toHaveBeenCalledOnce());

    vi.mocked(getSettings).mockResolvedValue({
      captureFolderPath: "file:///work",
      vaultProfiles: [
        { id: "default", name: "Personal", rootUri: "file:///personal", createdAt: 0 },
        { id: "work", name: "Work", rootUri: "file:///work", createdAt: 1 },
      ],
      activeVaultProfileId: "work",
    } as Awaited<ReturnType<typeof getSettings>>);
    navigation.emit("focus");
    await waitFor(() => expect(screen.queryByText("Ideas/tail.md")).toBeNull());
    finishResolve({
      id: "tail",
      mode: "idea",
      title: "Tail",
      filepath: "file:///v/Ideas/tail.md",
      createdAt: 0,
    });

    await Promise.resolve();
    await Promise.resolve();
    expect(navigation.navigate).not.toHaveBeenCalledWith(
      "RecentDetail",
      expect.objectContaining({ entry: expect.objectContaining({ id: "tail" }) }),
    );
  });

  it("starts only one SAF-tail scan for rapid repeated taps", async () => {
    renderScreen();
    await screen.findByText("Jack's Baseball Team");
    let finishScan!: (result: { candidates: []; scanned: number; unreadable: number }) => void;
    vi.mocked(scanPossibleSafStaleTails).mockImplementationOnce(
      () => new Promise((resolve) => { finishScan = resolve; }),
    );

    const scan = screen.getByText("Scan");
    fireEvent.click(scan);
    fireEvent.click(scan);
    expect(scanPossibleSafStaleTails).toHaveBeenCalledOnce();

    finishScan({ candidates: [], scanned: 1, unreadable: 0 });
    await screen.findByText("No possible leftover text found in the notes checked");
  });

  it("shows the sync-conflict banner and pairs copies to originals in the review dialog", async () => {
    const conflict = {
      uri: "file:///v/Ideas/note.sync-conflict-20260716-093012-ABC123X.md",
      name: "note.sync-conflict-20260716-093012-ABC123X.md",
      subdir: "Ideas" as const,
    };
    const original = { uri: "file:///v/Ideas/note.md", name: "note.md", subdir: "Ideas" as const };
    vi.mocked(listSyncConflictFiles).mockResolvedValue([conflict]);
    vi.mocked(listNoteFiles).mockResolvedValue([original]);
    renderScreen();

    expect(
      await screen.findByText(
        "1 sync conflict in the vault — two versions of the same note exist",
      ),
    ).toBeTruthy();

    fireEvent.click(screen.getByText("Review"));
    // Pairing (real pairConflicts) joins the copy to Ideas/note.md.
    expect(await screen.findByText("Ideas/note.md")).toBeTruthy();
    expect(screen.getByText("Open copy")).toBeTruthy();
    expect(screen.getByText("Open original")).toBeTruthy();
  });

  it("installs the header actions (sync dot, search, settings) once sync status loads", async () => {
    const { navigation } = renderScreen();
    await screen.findByText("Jack's Baseball Team");
    await waitFor(() => {
      const calls = navigation.setOptions.mock.calls;
      expect(calls.some(([opts]) => typeof opts.headerRight === "function")).toBe(true);
    });
  });
});
