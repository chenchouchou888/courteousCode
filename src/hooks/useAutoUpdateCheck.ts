/** Get the cached update handle (from the latest successful check). Always null — auto-update is disabled. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function getUpdateHandle(): any {
  return null;
}

/**
 * Auto-update is disabled — this fork's updater endpoints are placeholders.
 * Kept as a no-op so the App.tsx call site and UpdateButton don't need changes.
 */
export function useAutoUpdateCheck(): void {
  // Intentionally empty.
}
