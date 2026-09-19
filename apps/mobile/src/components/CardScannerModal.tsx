import { useEffect, useRef, useState } from "react";
import { StyleSheet, View } from "react-native";
import {
  ActivityIndicator,
  Button,
  HelperText,
  IconButton,
  Modal,
  Portal,
  Text,
} from "react-native-paper";
import { CameraView, useCameraPermissions } from "expo-camera";

import {
  classifyBusinessCardViaVision,
  ocrCardViaVision,
} from "../lib/dispatcher";
import {
  cardScanHint,
  cardScanPreflightHint,
  classifyCardScanOcrError,
  probeCardScanReadiness,
  type CardScanOcrOutcome,
} from "../lib/cardScanOutcome";
import {
  saveBusinessCardCapture,
  saveRawOcrResult,
  type BusinessCardCapture,
} from "../lib/mdcrmCapturePackage";
import {
  createCardCaptureConfirmation,
  inspectBusinessCardPhoto,
  type CardPhoto,
} from "../lib/cardScanWorkflow";
import { getSettings } from "../lib/settings";
import { captureVaultContext } from "../lib/vaultContext";
import { resolveContextRoot } from "../lib/vaultRoot";

export interface CardScanResult {
  text: string;
  capture: BusinessCardCapture;
  /** Why `text` is empty, so the caller can advise the right next action. */
  ocr: CardScanOcrOutcome;
}

interface Props {
  visible: boolean;
  onResult: (result: CardScanResult) => void;
  onClose: () => void;
}

export function CardScannerModal({ visible, onResult, onClose }: Props) {
  const cameraRef = useRef<CameraView>(null);
  const [permission, requestPermission] = useCameraPermissions();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [preflight, setPreflight] = useState<string | null>(null);
  const [pendingPhoto, setPendingPhoto] = useState<CardPhoto | null>(null);
  const sessionRef = useRef(0);
  const confirmationRef = useRef<ReturnType<typeof createCardCaptureConfirmation> | null>(null);

  // Tell the user their provider is unset BEFORE they frame a shot, rather
  // than after a wasted round trip. Deliberately fire-and-forget: the probe
  // reads settings + SecureStore, and awaiting it here would delay the camera
  // preview for everyone to benefit the misconfigured minority. A captured
  // image is classified first and remains in memory until the user confirms.
  useEffect(() => {
    sessionRef.current += 1;
    setBusy(false);
    setError(null);
    setPendingPhoto(null);
    confirmationRef.current = null;
    if (!visible) {
      setPreflight(null);
      return;
    }
    let cancelled = false;
    void probeCardScanReadiness().then((outcome) => {
      if (!cancelled) setPreflight(cardScanPreflightHint(outcome));
    });
    return () => {
      cancelled = true;
    };
  }, [visible]);

  const handleClose = () => {
    // Invalidate both an in-flight shutter/classifier and a pending confirmation
    // synchronously; waiting for React's visible=false render loses that race.
    sessionRef.current += 1;
    confirmationRef.current = null;
    setPendingPhoto(null);
    onClose();
  };

  const capture = async () => {
    if (!cameraRef.current) return;
    const session = sessionRef.current;
    setError(null);
    setBusy(true);
    try {
      // The photo is the user action that starts this package. Freeze its
      // destination before any camera/provider await so confirmation cannot
      // follow a later profile switch into another vault.
      const captureContext = captureVaultContext(await getSettings());
      const photo = await cameraRef.current.takePictureAsync({
        base64: true,
        quality: 0.6,
      });
      if (!photo?.base64) {
        throw new Error("no image captured");
      }
      if (sessionRef.current !== session) return;
      const cardPhoto = { base64: photo.base64, mimeType: "image/jpeg" };
      const inspection = await inspectBusinessCardPhoto(cardPhoto, (input) =>
        classifyBusinessCardViaVision(input),
      );
      if (sessionRef.current !== session) return;
      if (inspection.kind === "suggest-card") {
        confirmationRef.current = createCardCaptureConfirmation(inspection.photo, {
          saveCapture: async (input) =>
            saveBusinessCardCapture({
              imageBase64: input.base64,
              mimeType: input.mimeType,
              rootOverride: resolveContextRoot(captureContext),
            }),
          ocr: (input) => ocrCardViaVision(input),
          saveRawOcr: saveRawOcrResult,
          classifyOcrError: classifyCardScanOcrError,
        });
        setPendingPhoto(inspection.photo);
      } else {
        setError(manualEntryMessage(inspection.reason));
      }
    } catch (e: unknown) {
      if (sessionRef.current === session) {
        setError(e instanceof Error ? e.message : String(e));
      }
    } finally {
      if (sessionRef.current === session) setBusy(false);
    }
  };

  const confirm = async () => {
    const confirmation = confirmationRef.current;
    if (!confirmation) return;
    const session = sessionRef.current;
    setError(null);
    setBusy(true);
    try {
      const result = await confirmation.confirm();
      if (sessionRef.current !== session) return;
      onResult({ text: result.text, capture: result.capture, ocr: result.ocr });
      if (result.ocr.kind === "ok") {
        handleClose();
      } else {
        confirmationRef.current = null;
        setPendingPhoto(null);
        setError(cardScanHint(result.ocr));
      }
    } catch (e: unknown) {
      if (sessionRef.current === session) {
        setError(e instanceof Error ? e.message : String(e));
      }
    } finally {
      if (sessionRef.current === session) setBusy(false);
    }
  };

  const retake = () => {
    confirmationRef.current = null;
    setPendingPhoto(null);
    setError(null);
  };

  const grant = async () => {
    const result = await requestPermission();
    if (!result.granted) {
      setError("Camera permission denied");
    }
  };

  return (
    <Portal>
      <Modal
        visible={visible}
        onDismiss={handleClose}
        contentContainerStyle={styles.modal}
      >
        <View style={styles.header}>
          <Text variant="titleMedium">Scan card</Text>
          <IconButton
            icon="close"
            onPress={handleClose}
            accessibilityLabel="Close and enter manually"
            disabled={busy}
          />
        </View>

        {!permission ? (
          <View style={styles.body}>
            <ActivityIndicator />
          </View>
        ) : !permission.granted ? (
          <View style={styles.body}>
            <Text>Camera permission required.</Text>
            <Button mode="contained" onPress={grant} style={styles.grantBtn}>
              Allow camera
            </Button>
          </View>
        ) : (
          <View style={styles.body}>
            {preflight && (
              <HelperText type="error" visible>
                {preflight}
              </HelperText>
            )}
            {pendingPhoto ? (
              <>
                <Text>This looks like a business card.</Text>
                <Button
                  mode="contained"
                  onPress={confirm}
                  loading={busy}
                  disabled={busy}
                >
                  Use as business card
                </Button>
                <Button mode="outlined" onPress={retake} disabled={busy}>
                  Retake
                </Button>
                <Button mode="text" onPress={handleClose} disabled={busy}>
                  Enter manually
                </Button>
              </>
            ) : (
              <>
                <CameraView ref={cameraRef} style={styles.camera} facing="back" />
                <Button
                  mode="contained"
                  icon="camera"
                  onPress={capture}
                  loading={busy}
                  disabled={busy}
                  style={styles.captureBtn}
                >
                  Capture
                </Button>
              </>
            )}
            {busy && (
              <HelperText type="info" visible>
                {pendingPhoto ? "Saving and reading card…" : "Checking card…"}
              </HelperText>
            )}
            {error && (
              <HelperText type="error" visible>
                {error}
              </HelperText>
            )}
          </View>
        )}
      </Modal>
    </Portal>
  );
}

function manualEntryMessage(reason: "not-card" | "uncertain" | "unavailable"): string {
  switch (reason) {
    case "not-card":
      return "That does not look like a business card. Retake it or enter the contact manually.";
    case "uncertain":
      return "We could not tell whether this is a business card. Retake it or enter the contact manually.";
    case "unavailable":
      return "Card detection is unavailable. Retake it later or enter the contact manually.";
  }
}

const styles = StyleSheet.create({
  modal: {
    backgroundColor: "white",
    margin: 16,
    padding: 0,
    borderRadius: 12,
    overflow: "hidden",
  },
  header: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    paddingLeft: 16,
  },
  body: {
    padding: 16,
    gap: 12,
  },
  camera: {
    aspectRatio: 3 / 4,
    width: "100%",
    borderRadius: 8,
    overflow: "hidden",
  },
  captureBtn: {},
  grantBtn: {
    marginTop: 12,
  },
});
