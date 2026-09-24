/**
 * Headless JS task registration for the notification inline-reply quick idea
 * (Stage 2 / branch B5).
 *
 * QuickIdeaTaskService (a native HeadlessJsTaskService emitted by
 * plugins/withCaptureNotification.js) starts this task by name with the typed
 * text as `data.text` — with the app closed. The task runs the save-first
 * capture and returns.
 *
 * This file has a side effect (registers the task on import) and imports the
 * React Native AppRegistry, so it is imported only from index.js at app startup
 * and NOT from the unit-tested handler module — handleQuickIdeaCapture stays
 * renderer-free and testable on its own.
 *
 * QUICK_IDEA_TASK_NAME must stay byte-identical to the task name the native
 * QuickIdeaTaskService.getTaskConfig() passes ("CarnetQuickIdea"); they are the
 * two ends of the same bridge and a drift silently drops every quick capture.
 */

import { AppRegistry } from "react-native";
import { handleQuickIdeaCapture } from "./notificationQuickIdea";
import { isVaultContext, type VaultContext } from "./vaultContext";

/** Must match QuickIdeaTaskService.getTaskConfig() in withCaptureNotification.js. */
export const QUICK_IDEA_TASK_NAME = "CarnetQuickIdea";

/**
 * Data accepted from QuickIdeaTaskService. Generic notification replies carry
 * only `text`; Android Auto receipts additionally carry the immutable vault
 * selected when the reply was accepted. `receiptId` remains native-owned
 * duplicate protection, but is typed here so the bridge contract is explicit.
 */
export interface QuickIdeaTaskData {
  text?: string;
  receiptId?: string;
  profileId?: string;
  rootUri?: string;
}

function receiptVaultContext(data: QuickIdeaTaskData | undefined): VaultContext | undefined {
  const candidate = {
    profileId: data?.profileId,
    rootUri: data?.rootUri,
  };
  return isVaultContext(candidate) ? candidate : undefined;
}

AppRegistry.registerHeadlessTask(
  QUICK_IDEA_TASK_NAME,
  () => async (data: QuickIdeaTaskData) => {
    await handleQuickIdeaCapture(
      data?.text ?? "",
      receiptVaultContext(data),
      data?.receiptId,
    );
  },
);
