/** Per-vault, single-flight reconciliation gate. UI renders cached data first. */
export type VaultRefreshStatus = "idle" | "refreshing" | "current" | "stale" | "unavailable";

export interface VaultRefreshCoordinator {
  refresh(profileId: string, scan: () => Promise<void>): Promise<VaultRefreshStatus>;
  status(profileId: string): VaultRefreshStatus;
}

export function createVaultRefreshCoordinator(
  now: () => number,
  throttleMs = 30_000,
): VaultRefreshCoordinator {
  const states = new Map<string, { status: VaultRefreshStatus; completedAt: number; inFlight?: Promise<VaultRefreshStatus> }>();
  const stateFor = (id: string) => states.get(id) ?? { status: "idle" as const, completedAt: 0 };
  return {
    status: (id) => stateFor(id).status,
    refresh(profileId, scan) {
      const state = stateFor(profileId);
      if (state.inFlight) return state.inFlight;
      if (state.status === "current" && now() - state.completedAt < throttleMs) return Promise.resolve("current");
      state.status = "refreshing";
      const inFlight = scan().then(
        () => "current" as const,
        (error: unknown) => {
          state.status = error instanceof Error && /permission|denied|revoked/i.test(error.message) ? "unavailable" : "stale";
          return state.status;
        },
      ).then((status) => {
        state.status = status;
        state.completedAt = now();
        state.inFlight = undefined;
        states.set(profileId, state);
        return status;
      });
      state.inFlight = inFlight;
      states.set(profileId, state);
      return inFlight;
    },
  };
}
