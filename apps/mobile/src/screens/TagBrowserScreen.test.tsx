// @vitest-environment jsdom
//
// First screen smoke test. Renders the REAL component tree (react-native
// aliased to react-native-web, real react-native-paper under the real
// carnetLight theme) in Node — no device, no Metro. Native-module deps are
// stubbed via vitest.config.ts aliases; data deps are vi.mock'd per test.
//
// What this protects: the redesign's tag→search wiring (tapping a tag lands
// in Search pre-filtered, NOT the old TagBrowser drill-down), plus the
// screen's three data states (loading, tags, empty).
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { PaperProvider } from "react-native-paper";

import { carnetLight } from "../lib/theme";

// react-navigation needs a real navigator context; smoke tests fake the two
// hooks/props the screen consumes instead of mounting a NavigationContainer.
vi.mock("@react-navigation/native", async () => {
  const { useEffect } = await import("react");
  return {
    // Real useFocusEffect fires on screen focus; in tests, mount = focus.
    useFocusEffect: (cb: () => void | (() => void)) => {
      useEffect(cb, [cb]);
    },
  };
});

vi.mock("../lib/vault", () => ({
  deriveTagIndex: vi.fn((index: { builtAt: number }) => ({ builtAt: index.builtAt, tags: [] })),
  getTagIndex: vi.fn(async () => ({
    builtAt: 1,
    tags: [
      { tag: "qa-test", count: 2, files: ["file:///v/Ideas/a.md", "file:///v/Ideas/b.md"] },
      { tag: "sports", count: 1, files: ["file:///v/Ideas/c.md"] },
    ],
  })),
  refreshTagIndex: vi.fn(async () => ({ builtAt: 2, tags: [] })),
  notesForTag: vi.fn(async () => []),
}));
vi.mock("../lib/vaultRefreshService", () => ({ refreshActiveVault: vi.fn(async () => {}) }));
vi.mock("../lib/settings", () => ({ getSettings: vi.fn(async () => ({ captureFolderPath: "" })) }));
vi.mock("../lib/vaultRoot", () => ({
  resolveContextRoot: vi.fn(() => ({ uri: "file:///vault", fs: {} })),
}));

import TagBrowserScreen from "./TagBrowserScreen";
import { getTagIndex } from "../lib/vault";
import { refreshActiveVault } from "../lib/vaultRefreshService";

type ScreenProps = Parameters<typeof TagBrowserScreen>[0];

function makeNavigation() {
  return {
    setOptions: vi.fn(),
    navigate: vi.fn(),
    push: vi.fn(),
    goBack: vi.fn(),
    addListener: vi.fn(() => vi.fn()),
    dispatch: vi.fn(),
  };
}

function renderScreen(params?: { tag?: string }) {
  const navigation = makeNavigation();
  render(
    <PaperProvider theme={carnetLight}>
      <TagBrowserScreen
        navigation={navigation as unknown as ScreenProps["navigation"]}
        route={{ key: "t", name: "TagBrowser", params } as ScreenProps["route"]}
      />
    </PaperProvider>,
  );
  return { navigation };
}

beforeEach(() => {
  vi.clearAllMocks();
});

// RTL's automatic cleanup needs vitest globals (this repo runs without
// them), so unmount explicitly or renders leak across tests.
afterEach(cleanup);

describe("TagBrowserScreen", () => {
  it("lists the vault's tags with counts once the index loads", async () => {
    renderScreen();
    expect(await screen.findByText("#qa-test")).toBeTruthy();
    expect(screen.getByText("#sports")).toBeTruthy();
    expect(screen.getByText("2")).toBeTruthy();
    expect(screen.getByText("1")).toBeTruthy();
    expect(getTagIndex).toHaveBeenCalledTimes(1);
  });

  it("schedules a background vault reconciliation when focused", async () => {
    renderScreen();
    await screen.findByText("#qa-test");
    expect(refreshActiveVault).toHaveBeenCalled();
  });

  it("sets the header title", async () => {
    const { navigation } = renderScreen();
    await screen.findByText("#qa-test");
    expect(navigation.setOptions).toHaveBeenCalledWith({ title: "Tags" });
  });

  it("routes a tag tap into pre-filtered Search (not the old drill-down)", async () => {
    const { navigation } = renderScreen();
    fireEvent.click(await screen.findByText("#qa-test"));
    await waitFor(() =>
      expect(navigation.navigate).toHaveBeenCalledWith("Search", { tag: "qa-test" }),
    );
    expect(navigation.push).not.toHaveBeenCalled();
  });

  it("shows the empty state when the vault has no tags", async () => {
    vi.mocked(getTagIndex).mockResolvedValueOnce({ builtAt: 1, tags: [] });
    renderScreen();
    expect(
      await screen.findByText("No tags yet — add tags when you capture."),
    ).toBeTruthy();
  });
});
