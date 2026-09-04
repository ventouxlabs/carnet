import "react-native-gesture-handler";
// FIRST app-code import on purpose: stamps BOOT_TIMESTAMP_MS as close to
// JS-bundle evaluation start as app code can get (cold-start budget,
// lib/startupTiming.ts). Home reports against it on first mount.
import "./src/lib/startupTiming";
import { useCallback, useEffect, useRef, useState } from "react";
import { ActivityIndicator, AppState, useColorScheme, View } from "react-native";
import {
  DarkTheme as NavDarkTheme,
  DefaultTheme as NavLightTheme,
  type LinkingOptions,
  NavigationContainer,
  useNavigationContainerRef,
  type NavigationContainerRefWithCurrent,
  type Theme as NavTheme,
} from "@react-navigation/native";
import { createNativeStackNavigator } from "@react-navigation/native-stack";
import { IconButton, PaperProvider } from "react-native-paper";
import { StatusBar } from "expo-status-bar";
import { ShareIntentProvider, useShareIntentContext } from "expo-share-intent";
import { useFonts } from "expo-font";
import { Inter_400Regular, Inter_500Medium } from "@expo-google-fonts/inter";
import { SpaceGrotesk_600SemiBold } from "@expo-google-fonts/space-grotesk";

import { CrashBoundary } from "./src/components/CrashBoundary";
import { installGlobalCrashHandler } from "./src/lib/crashReporting";
import HomeScreen from "./src/screens/HomeScreen";
import CaptureScreen from "./src/screens/CaptureScreen";
import SettingsScreen from "./src/screens/SettingsScreen";
import ShareReceiveScreen from "./src/screens/ShareReceiveScreen";
import PhotoCaptureScreen from "./src/screens/PhotoCaptureScreen";
import AudioCaptureScreen from "./src/screens/AudioCaptureScreen";
import RecentDetailScreen from "./src/screens/RecentDetailScreen";
import TagBrowserScreen from "./src/screens/TagBrowserScreen";
import SearchScreen from "./src/screens/SearchScreen";
import TodosScreen from "./src/screens/TodosScreen";
import type { CaptureEntry, CaptureMode } from "./src/lib/storage";
import { carnetDark, carnetLight } from "./src/lib/theme";
import {
  getThemePreference,
  setThemePreference,
  ThemePreferenceContext,
  type ThemePreference,
} from "./src/lib/themePreference";
import { drainPendingKarakeepExports } from "./src/lib/pendingSyncRunner";
import { drainQueue } from "./src/lib/queue";
import {
  createForegroundDrainTrigger,
  type ForegroundDrainTrigger,
} from "./src/lib/foregroundDrainTrigger";

// Installed once at module load, as early as possible — chains onto RN's
// default handler so every uncaught JS exception lands in the local crash
// log (lib/crashLog.ts) before redbox/restart handling runs. See
// .claude/PRPs/plans/completed/self-hosted-sentry.plan.md.
installGlobalCrashHandler();

export type RootStackParamList = {
  Home: undefined;
  Capture: { mode: CaptureMode };
  Settings: undefined;
  ShareReceive: undefined;
  PhotoCapture: undefined;
  AudioCapture: undefined;
  RecentDetail: { entry: CaptureEntry };
  TagBrowser: { tag?: string } | undefined;
  /** `tag` pre-applies a tag filter — how "tap a tag anywhere" lands here. */
  Search: { tag?: string } | undefined;
  Todos: undefined;
};

const Stack = createNativeStackNavigator<RootStackParamList>();

// Deep-link routing. Drives the Android app-shortcuts (long-press launcher
// icon → Idea/Journal/Photo/Contact) and any other carnet:// URI the OS
// hands the app. The custom scheme is declared in app.json; this config
// only maps URL paths to stack screens.
//
// SECURITY MODEL — deep-link routes are passive. They navigate; they never
// auto-act on params. The carnet:// scheme is global on the device, so any
// other app can fire a VIEW intent at us. Every screen reachable via this
// linking config is a passive form where the user has to tap Save (or an
// equivalent action) before anything is written. If a future route gains
// an auto-action (e.g. carnet://import?url=X that fetches + saves), it
// MUST validate the param and surface a user-confirm step before firing.
//
// RecentDetail is intentionally omitted — its param is a CaptureEntry
// object which can't be url-encoded cleanly. Deep-linking into a specific
// recent isn't a use case we're solving today.
const linking: LinkingOptions<RootStackParamList> = {
  prefixes: ["carnet://"],
  config: {
    screens: {
      Home: "",
      Capture: "capture/:mode",
      PhotoCapture: "photo",
      AudioCapture: "audio",
      Settings: "settings",
      ShareReceive: "share-receive",
    },
  },
};

/**
 * Watches for incoming Android share intents and routes to ShareReceive
 * exactly once per intent. The `routedKey` ref prevents re-routing when the
 * provider re-renders with the same intent payload still attached.
 */
function ShareIntentRouter({
  navigation,
}: {
  navigation: NavigationContainerRefWithCurrent<RootStackParamList>;
}) {
  const { hasShareIntent, shareIntent } = useShareIntentContext();
  const routedKey = useRef<string | null>(null);

  useEffect(() => {
    if (!hasShareIntent || !shareIntent) {
      // Share was reset (Cancel / Done) — clear the dedup key so a *second*
      // identical share later in the session still routes. Without this,
      // the same image shared twice in a row is silently dropped.
      routedKey.current = null;
      return;
    }
    // Synthesize a stable key from the payload — re-routes only when a
    // genuinely new share lands.
    const key = `${shareIntent.text ?? ""}|${shareIntent.webUrl ?? ""}|${(shareIntent.files ?? []).map((f) => f.path).join(",")}`;
    if (routedKey.current === key) return;
    routedKey.current = key;
    if (navigation.isReady()) {
      navigation.navigate("ShareReceive");
    }
  }, [hasShareIntent, shareIntent, navigation]);

  return null;
}

export default function App() {
  const [ready, setReady] = useState(false);
  const navRef = useNavigationContainerRef<RootStackParamList>();
  // Bundled type: Space Grotesk for headings, Inter for body/labels. The
  // theme's font config references these families by name, so rendering is
  // gated below until they're loaded.
  const [fontsLoaded, fontError] = useFonts({
    Inter_400Regular,
    Inter_500Medium,
    SpaceGrotesk_600SemiBold,
  });
  // A failed font load must not strand the app on the boot spinner — the
  // theme's families just fall back to system faces for the session.
  const fontsReady = fontsLoaded || fontError != null;
  // OS light/dark setting (userInterfaceStyle="automatic" in app.json lets
  // the system flip it live), overridable by the in-app Appearance setting:
  // "system" follows the OS, "light"/"dark" pin the theme.
  const colorScheme = useColorScheme();
  const [preference, setPreferenceState] =
    useState<ThemePreference>("system");
  const resolvedScheme =
    preference === "system" ? (colorScheme ?? "light") : preference;
  const paperTheme = resolvedScheme === "dark" ? carnetDark : carnetLight;

  const setPreference = useCallback((next: ThemePreference) => {
    setPreferenceState(next);
    // Persist in the background; the UI already switched. A failed write
    // only costs the preference on next launch, and stranding the toggle
    // on a storage error would be worse.
    setThemePreference(next).catch((e: unknown) => {
      const msg = e instanceof Error ? e.message : String(e);
      console.warn("[App] failed to persist theme preference:", msg);
    });
  }, []);
  // Derive a React Navigation theme so the native-stack header bar matches
  // the Paper-themed screen body. Without this, the header would render
  // with RN Navigation's default light theme on top of our ink-dark surface.
  const navTheme: NavTheme = {
    ...(resolvedScheme === "dark" ? NavDarkTheme : NavLightTheme),
    colors: {
      ...(resolvedScheme === "dark" ? NavDarkTheme : NavLightTheme).colors,
      primary: paperTheme.colors.primary,
      background: paperTheme.colors.background,
      card: paperTheme.colors.surface,
      text: paperTheme.colors.onSurface,
      border: paperTheme.colors.outline,
      notification: paperTheme.colors.error,
    },
  };

  // Pending-sync drain trigger: cold start + every return to foreground,
  // throttled so rapid app-switching doesn't spam reachability probes. The
  // drain itself is single-flight, empty-queue-cheap, and never throws
  // (lib/pendingSync.ts + lib/pendingSyncRunner.ts) — this only decides WHEN.
  const lastPendingDrainRef = useRef(0);
  useEffect(() => {
    const PENDING_DRAIN_THROTTLE_MS = 30_000;
    const kickPendingDrain = () => {
      const now = Date.now();
      if (now - lastPendingDrainRef.current < PENDING_DRAIN_THROTTLE_MS) return;
      lastPendingDrainRef.current = now;
      void drainPendingKarakeepExports();
    };
    kickPendingDrain();
    const sub = AppState.addEventListener("change", (state) => {
      if (state === "active") kickPendingDrain();
    });
    return () => sub.remove();
  }, []);

  // Enrichment-queue drain trigger: cold start + every return to foreground,
  // same throttle shape as the Karakeep trigger above (independent queue, its
  // own trigger instance so one system's throttle window never gates the
  // other — see lib/foregroundDrainTrigger.ts). Previously drainQueue() only
  // ran on CaptureScreen mount and manual retry, so a capture queued while
  // offline sat stuck until the user next opened Capture — syncStatus.ts's
  // "will finish automatically when reachable" wasn't true. drainQueue()
  // itself is single-flight (lib/queue.ts's `_draining` guard) and a cheap
  // no-op on an empty queue, so this only decides WHEN to kick it.
  // useRef(factory()) would call the factory on EVERY render (only the ref
  // object itself is stable, not its initializer argument) — lazy-init via
  // ??= so createForegroundDrainTrigger runs exactly once.
  const queueDrainTriggerRef = useRef<ForegroundDrainTrigger | null>(null);
  queueDrainTriggerRef.current ??= createForegroundDrainTrigger(
    drainQueue,
    30_000,
    "App:queue",
  );
  const queueDrainTrigger = queueDrainTriggerRef.current;
  useEffect(() => {
    queueDrainTrigger.kick();
    const sub = AppState.addEventListener("change", (state) => {
      if (state === "active") queueDrainTrigger.kick();
    });
    return () => sub.remove();
  }, [queueDrainTrigger]);

  useEffect(() => {
    // Load the persisted theme override before first paint so the app
    // doesn't flash the wrong scheme, then render navigation.
    let cancelled = false;
    getThemePreference()
      .then((stored) => {
        if (!cancelled) setPreferenceState(stored);
      })
      // A failed read keeps the default scheme — the correct fallback; the
      // finally below still unblocks first paint either way.
      .catch(() => undefined)
      .finally(() => {
        if (!cancelled) setReady(true);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  if (!ready || !fontsReady) {
    return (
      <View
        style={{
          flex: 1,
          alignItems: "center",
          justifyContent: "center",
          backgroundColor: paperTheme.colors.background,
        }}
      >
        <ActivityIndicator color={paperTheme.colors.primary} />
      </View>
    );
  }

  return (
    <ShareIntentProvider>
      <ThemePreferenceContext.Provider value={{ preference, setPreference }}>
        <PaperProvider theme={paperTheme}>
          <CrashBoundary>
            <NavigationContainer ref={navRef} theme={navTheme} linking={linking}>
              {/* Explicit style (not "auto") so the bar follows the manual
                  override too, not just the OS scheme. */}
              <StatusBar style={resolvedScheme === "dark" ? "light" : "dark"} />
              <Stack.Navigator initialRouteName="Home">
                <Stack.Screen
                  name="Home"
                  component={HomeScreen}
                  options={{ title: "Carnet" }}
                />
                <Stack.Screen
                  name="Capture"
                  component={CaptureScreen}
                  options={({ route }) => ({
                    title:
                      route.params.mode === "idea"
                        ? "Idea"
                        : route.params.mode === "journal"
                          ? "Journal"
                          : "Contact",
                  })}
                />
                <Stack.Screen
                  name="Settings"
                  component={SettingsScreen}
                  options={{ title: "Settings" }}
                />
                <Stack.Screen
                  name="ShareReceive"
                  component={ShareReceiveScreen}
                  options={{ title: "Shared" }}
                />
                <Stack.Screen
                  name="PhotoCapture"
                  component={PhotoCaptureScreen}
                  options={{ title: "Photo" }}
                />
                <Stack.Screen
                  name="AudioCapture"
                  component={AudioCaptureScreen}
                  options={{ title: "Audio" }}
                />
                <Stack.Screen
                  name="RecentDetail"
                  component={RecentDetailScreen}
                  options={({ route }) => ({ title: route.params.entry.title })}
                />
                <Stack.Screen name="TagBrowser" component={TagBrowserScreen} options={{ title: "Tags" }} />
                <Stack.Screen name="Todos" component={TodosScreen} options={{ title: "Todos" }} />
                <Stack.Screen
                  name="Search"
                  component={SearchScreen}
                  options={({ navigation }) => ({
                    title: "Search",
                    // Tags moved out of the Home header (one primary action per
                    // screen) — browsing by tag now lives with search.
                    headerRight: () => (
                      <IconButton
                        icon="tag-multiple-outline"
                        onPress={() => navigation.navigate("TagBrowser")}
                        accessibilityLabel="Browse tags"
                      />
                    ),
                  })}
                />
              </Stack.Navigator>
              <ShareIntentRouter navigation={navRef} />
            </NavigationContainer>
          </CrashBoundary>
        </PaperProvider>
      </ThemePreferenceContext.Provider>
    </ShareIntentProvider>
  );
}
