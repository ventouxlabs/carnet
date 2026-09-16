// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { PaperProvider } from "react-native-paper";

const takePictureAsync = vi.fn();
const requestPermission = vi.fn();

vi.mock("expo-camera", async () => {
  const { forwardRef, useImperativeHandle } = await import("react");
  const { View } = await import("react-native");
  return {
    CameraView: forwardRef((_props: Record<string, unknown>, ref: unknown) => {
      useImperativeHandle(ref as never, () => ({ takePictureAsync }));
      return <View testID="camera-view" />;
    }),
    useCameraPermissions: () => [{ granted: true }, requestPermission] as const,
  };
});

vi.mock("../lib/dispatcher", () => ({
  classifyBusinessCardViaVision: vi.fn(),
  ocrCardViaVision: vi.fn(),
  probeVisionReadiness: vi.fn(async () => {}),
  isNotConfiguredError: vi.fn(() => false),
  isPermanentError: vi.fn(() => false),
  isInsecureTransportError: vi.fn(() => false),
}));

vi.mock("../lib/mdcrmCapturePackage", () => ({
  saveBusinessCardCapture: vi.fn(),
  saveRawOcrResult: vi.fn(),
}));
vi.mock("../lib/settings", () => ({ getSettings: vi.fn(async () => ({ captureFolderPath: "" })) }));
vi.mock("../lib/vaultRoot", () => ({
  resolveContextRoot: vi.fn(() => ({ uri: "file:///vault", fs: {} })),
}));

import { CardScannerModal } from "./CardScannerModal";
import {
  classifyBusinessCardViaVision,
  ocrCardViaVision,
} from "../lib/dispatcher";
import {
  saveBusinessCardCapture,
  saveRawOcrResult,
} from "../lib/mdcrmCapturePackage";
import { resolveContextRoot } from "../lib/vaultRoot";
import { carnetLight } from "../lib/theme";

const saved = { captureId: "cap_1", attachmentId: "att_1", rawOcrPath: "file:///raw.txt" };

function renderModal() {
  const onResult = vi.fn();
  const onClose = vi.fn();
  render(
    <PaperProvider theme={carnetLight}>
      <CardScannerModal visible onResult={onResult} onClose={onClose} />
    </PaperProvider>,
  );
  return { onResult, onClose };
}

beforeEach(() => {
  vi.clearAllMocks();
  takePictureAsync.mockResolvedValue({ base64: "PHOTO" });
  vi.mocked(classifyBusinessCardViaVision).mockResolvedValue({ classification: "card" });
  vi.mocked(saveBusinessCardCapture).mockResolvedValue(saved);
  vi.mocked(ocrCardViaVision).mockResolvedValue({ text: "Jane Doe" });
  vi.mocked(saveRawOcrResult).mockResolvedValue();
});

afterEach(cleanup);

describe("CardScannerModal", () => {
  it("shows a positive card suggestion without writing or OCRing until Use as business card", async () => {
    const { onResult, onClose } = renderModal();

    fireEvent.click(screen.getByText("Capture"));

    expect(await screen.findByText("Use as business card")).toBeTruthy();
    expect(saveBusinessCardCapture).not.toHaveBeenCalled();
    expect(ocrCardViaVision).not.toHaveBeenCalled();
    expect(onResult).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();

    fireEvent.click(screen.getByText("Use as business card"));

    await waitFor(() => expect(saveBusinessCardCapture).toHaveBeenCalledTimes(1));
    expect(resolveContextRoot).toHaveBeenCalledWith({ profileId: "default", rootUri: "" });
    expect(saveBusinessCardCapture).toHaveBeenCalledWith(
      expect.objectContaining({ rootOverride: { uri: "file:///vault", fs: {} } }),
    );
    expect(ocrCardViaVision).toHaveBeenCalledWith({ base64: "PHOTO", mimeType: "image/jpeg" });
    expect(saveRawOcrResult).toHaveBeenCalledWith(saved, "Jane Doe");
    expect(onResult).toHaveBeenCalledWith({ text: "Jane Doe", capture: saved, ocr: { kind: "ok" } });
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
