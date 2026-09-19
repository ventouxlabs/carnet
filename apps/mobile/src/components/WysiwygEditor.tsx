import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef } from 'react';
import { View, StyleSheet } from 'react-native';
import { RichText, Toolbar, useEditorBridge, TenTapStartKit } from '@10play/tentap-editor';
import { useTheme, type MD3Theme } from 'react-native-paper';
import { editorHtml } from '../../editor-web/generated/editorHtml';
import { MarkdownBridge, awaitMarkdownResponse, onceContentAck } from '../bridges/MarkdownBridge';
import {
  buildCanonicalImage,
  buildEditorImage,
  isSuspiciousBlanking,
  photoEmbedRels,
  restoreImagesFromEditor,
} from '../lib/editorImages';
import { resolvePhotoDataUri } from '../lib/photoDataUri';
import type { Root } from '../lib/vaultRoot';

// Higher-contrast toolbar icons than TenTap's washed-out greys, tinted from the
// active Paper theme so the bar holds contrast in dark mode too. Deep-merged
// over the default theme by useEditorBridge (lodash merge), so only these keys
// change: active icons take the theme's text color, the toolbar bar takes the
// theme surface, and the disabled state (shown whenever the editor isn't
// focused) stays clearly visible instead of fading to a faint #CACACA.
function editorTheme(colors: MD3Theme['colors']) {
  return {
    toolbar: {
      toolbarBody: { backgroundColor: colors.surface, borderTopColor: colors.outline, borderBottomColor: colors.outline },
      icon: { tintColor: colors.onSurface },
      iconDisabled: { tintColor: colors.onSurfaceVariant },
      iconWrapper: { backgroundColor: colors.surface },
      iconWrapperActive: { backgroundColor: colors.secondaryContainer },
      iconWrapperDisabled: { opacity: 0.55 },
    },
  };
}

// Re-send schedule for the idempotent body injection (ms). A setMarkdown sent
// before the WebView bridge is listening is silently dropped, and the ~800 KB
// bundle's cold start can outlast a single timer, so re-send across a staircase
// until the content-ack lands. See tryInject.
const INJECT_STAIRCASE_MS = [100, 400, 900];
// If no content-ack ever arrives, unstick the editor anyway (best-effort). Longer
// than the staircase so a normal ack always wins; the save-time blanking guard
// stays strict while unconfirmed, so this fallback can never blank a note.
const INJECT_ACK_FALLBACK_MS = 4000;

export interface WysiwygEditorRef {
  /** Resolve the current editor content as a markdown string (read on save).
   * Editor-side `data:` image embeds are restored to canonical `../Photos/...`
   * links so the saved `.md` never carries a base64 blob. Rejects rather than
   * return a suspiciously-empty body when the injection was never confirmed. */
  getMarkdown: () => Promise<string>;
  /** Insert an image embed at the cursor. `dataUri` renders it in-editor while
   * `rel` (`../Photos/<file>`) is what serializes to disk; pass `dataUri: null`
   * to insert the canonical link without an in-editor preview (e.g. too large). */
  insertImage: (rel: string, dataUri: string | null) => void;
}

interface WysiwygEditorProps {
  /** Initial markdown body (frontmatter already split off by the caller). */
  value: string;
  /** Root frozen by the note route for existing image previews. */
  rootOverride?: Root;
}

/**
 * WYSIWYG note-body editor backed by TenTap (TipTap inside a WebView). Only ever
 * exchanges MARKDOWN — carnet's on-disk source of truth — via MarkdownBridge.
 * The caller injects the body once on mount and reads the edited body back on
 * demand through the imperative getMarkdown() handle.
 *
 * Images need special handling: the WebView loads at https://localhost/, so a
 * note's relative `![](../Photos/x.jpg)` embed can't resolve. We inject the body
 * with canonical links first (a small, reliable setMarkdown), wait for the
 * editor's content-ack, then swap each image to an inline `data:` URI via its own
 * bounded message — so a note's images never compound into one oversized payload
 * that opens the editor blank (issue #43). On the way out the canonical links are
 * restored. See ../lib/editorImages and ../bridges/MarkdownBridge.
 */
export const WysiwygEditor = forwardRef<WysiwygEditorRef, WysiwygEditorProps>(
  function WysiwygEditor({ value, rootOverride }, ref) {
    const theme = useTheme();
    const editor = useEditorBridge({
      customSource: editorHtml,
      // Give the WebView a real origin; without a baseUrl, Android loads with a
      // null origin and the bundle's <script type="module"> can be blocked.
      webviewBaseURL: 'https://localhost/',
      bridgeExtensions: [...TenTapStartKit, MarkdownBridge],
      autofocus: false,
      avoidIosKeyboard: true,
      // initialContent is HTML-only; the markdown body is injected after mount
      // via editor.setMarkdown (markdown passed here would be parsed as HTML).
      initialContent: '<p></p>',
      // Theme-derived toolbar tints (see editorTheme above). TenTap's defaults
      // are low-contrast greys (#898989 active, #CACACA @ 0.3 opacity when
      // disabled) which read as "greyed out"; deep-merged over the defaults.
      theme: editorTheme(theme.colors),
    });

    // Session map of `data:` URI → canonical `../Photos/...` path, populated as
    // images are swapped in on entry and inserted during the edit. It's the
    // fallback restore path if the editor ever drops our title marker (see
    // restoreImagesFromEditor); the title-carry path handles the common case.
    const imageMapRef = useRef<Map<string, string>>(new Map());
    // Set false on unmount so an in-flight swap loop stops touching a torn-down
    // editor.
    const aliveRef = useRef(true);

    // The images to swap to data URIs once the canonical body has landed. Derived
    // once from the mount-only `value` seed.
    const relsRef = useRef<string[]>([]);

    // Resolve a relative Photos embed to a data URI for in-editor display, and
    // remember the reverse mapping. Stable identity so the effects below don't re-run.
    const resolver = useCallback(async (rel: string): Promise<string | null> => {
      const dataUri = await resolvePhotoDataUri(rel, rootOverride);
      if (dataUri) imageMapRef.current.set(dataUri, rel);
      return dataUri;
    }, [rootOverride]);

    const loadedRef = useRef(false);
    const initializedRef = useRef(false);
    const injectTimersRef = useRef<ReturnType<typeof setTimeout>[]>([]);
    // Disposer for the pending content-ack registration, so unmount/fallback can
    // release the module-level slot instead of leaking a stale handler.
    const disposeAckRef = useRef<(() => void) | null>(null);
    // Flips true once the editor has CONFIRMED the body applied (content-ack) — or
    // the fallback fired. getMarkdown() refuses to read before this so a Save
    // tapped during cold start can't pull back the empty seed and blank the note.
    const bodyInjectedRef = useRef(false);
    // True only when the editor CONFIRMED a NON-EMPTY body applied (content-ack with
    // length > 0). The save-time blanking guard trusts an empty result only when the
    // body was confirmed loaded; a zero-length ack (body silently reduced to empty,
    // not just the transport surviving) is treated as unconfirmed so the guard bites.
    const ackedRef = useRef(false);
    // Guards the ack-or-fallback completion so it runs exactly once.
    const postInjectRef = useRef(false);

    const clearInjectTimers = useCallback(() => {
      injectTimersRef.current.forEach(clearTimeout);
      injectTimersRef.current = [];
    }, []);

    // Swap each pre-existing image to its data URI, one bounded message at a time
    // (sequential, so only one image's base64 is ever in flight). A failed/oversized
    // swap leaves the image canonical — broken in-editor, but saved + rendered fine.
    const runSwaps = useCallback(async () => {
      for (const rel of relsRef.current) {
        if (!aliveRef.current) return;
        try {
          const dataUri = await resolver(rel);
          if (dataUri && aliveRef.current) editor.setImageSrc(rel, dataUri);
        } catch {
          // leave canonical
        }
      }
    }, [editor, resolver]);

    // Runs once, on a CONFIRMING content-ack (confirmed=true, applied length > 0)
    // or the no-ack / zero-length fallback (false): mark the body safe to read,
    // stop re-sending setMarkdown so it can't clobber the swaps, then swap images in.
    const finishInjection = useCallback(
      (confirmed: boolean) => {
        if (postInjectRef.current) return;
        postInjectRef.current = true;
        ackedRef.current = confirmed;
        bodyInjectedRef.current = true;
        clearInjectTimers();
        void runSwaps();
      },
      [clearInjectTimers, runSwaps],
    );

    const tryInject = useCallback(() => {
      if (initializedRef.current || !loadedRef.current) return;
      initializedRef.current = true;
      const body = value;
      // Confirm the body really landed before reading it back or swapping images:
      // gate on the WebView's content-ack AND its applied length — a length-0 ack
      // means setContent reduced the body to empty (not merely that the transport
      // survived), which must NOT count as confirmed or the save guard goes blind.
      disposeAckRef.current = onceContentAck((len) => finishInjection(len > 0));
      injectTimersRef.current = INJECT_STAIRCASE_MS.map((delay) =>
        setTimeout(() => {
          // Once injection is finalized, swaps may have run — re-sending setMarkdown
          // would clobber a swapped node back to its canonical (broken) src.
          if (postInjectRef.current) return;
          editor.setMarkdown(body);
        }, delay),
      );
      // Fallback: no ack (e.g. a wedged bridge) shouldn't leave the editor stuck.
      const fallback = setTimeout(() => {
        disposeAckRef.current?.();
        finishInjection(false);
      }, INJECT_ACK_FALLBACK_MS);
      injectTimersRef.current.push(fallback);
    }, [editor, value, finishInjection]);

    // Capture the images to swap once on mount. `value` is a MOUNT-ONLY seed (the
    // caller remounts per edit session), so a later prop change is ignored.
    useEffect(() => {
      relsRef.current = photoEmbedRels(value);
    }, [value]);

    useEffect(() => {
      aliveRef.current = true;
      return () => {
        aliveRef.current = false;
        clearInjectTimers();
        disposeAckRef.current?.();
      };
    }, [clearInjectTimers]);

    const handleLoad = useCallback(() => {
      loadedRef.current = true;
      tryInject();
    }, [tryInject]);

    // Fallback in case the WebView onLoad never fires.
    useEffect(() => {
      const timer = setTimeout(() => {
        loadedRef.current = true;
        tryInject();
      }, 2500);
      return () => clearTimeout(timer);
    }, [tryInject]);

    useImperativeHandle(
      ref,
      () => ({
        getMarkdown: async () => {
          // Reading before the body is confirmed injected would return the editor's
          // empty `<p></p>` seed; the caller's `next === body` short-circuit wouldn't
          // catch that, so it would overwrite the note with a blank body. Refuse
          // instead — surfaces as a Save error, mirroring "Editor not mounted".
          if (!bodyInjectedRef.current) {
            throw new Error('Editor is still loading — wait a moment and try again.');
          }
          const response = awaitMarkdownResponse();
          editor.requestMarkdown();
          const raw = await response;
          // Strip the editor-side data URIs back to canonical `../Photos/...`
          // links before the body ever touches disk.
          const restored = restoreImagesFromEditor(raw, imageMapRef.current);
          // Last-line guard: if the body injection was never confirmed (the issue-#43
          // silent-drop) and the editor came back empty on a non-empty note, refuse
          // to write — never blank the note. An ack-confirmed empty body is a genuine
          // user clear and is allowed through.
          if (isSuspiciousBlanking({ original: value, result: restored, acked: ackedRef.current })) {
            throw new Error(
              'Could not confirm the note loaded into the editor — not saving, to avoid blanking it. Reopen and try again.',
            );
          }
          return restored;
        },
        insertImage: (rel, dataUri) => {
          if (dataUri) {
            imageMapRef.current.set(dataUri, rel);
            editor.insertMarkdown(buildEditorImage('', dataUri, rel));
          } else {
            // No preview (e.g. over the inline cap): insert the canonical link.
            // It shows broken in-editor but saves + renders correctly.
            editor.insertMarkdown(buildCanonicalImage('', rel));
          }
        },
      }),
      [editor, value],
    );

    return (
      <View style={styles.container}>
        {/* Formatting toolbar (bold/italic/headings/lists/code/link/quote) docked at
            the TOP of the editor, always visible. TenTap's Toolbar auto-hides when the
            keyboard is down (hidden===undefined), so we force hidden={false}.
            We dock it at the top rather than floating above the keyboard: the
            above-keyboard approach needs a native keyboard-inset module
            (react-native-keyboard-controller) whose transitive Google-Maven deps
            can't be fetched in this build environment. RN's own Keyboard height
            under-reports the Android edge-to-edge IME (it omits the suggestion strip),
            so a JS-only above-keyboard dock would tuck the toolbar behind that strip. */}
        <View style={styles.toolbarBar}>
          <Toolbar editor={editor} hidden={false} />
        </View>
        <View style={styles.editor}>
          <RichText editor={editor} onLoad={handleLoad} />
        </View>
      </View>
    );
  }
);

const styles = StyleSheet.create({
  container: { flex: 1 },
  // Pin the toolbar to a single row. TenTap's toolbarBody has flex:1, so as a
  // flex-column child it would otherwise balloon to fill half the screen; a
  // fixed-height parent forces it to its intended ~48px row.
  toolbarBar: { height: 48 },
  editor: { flex: 1 },
});
