import type { RefObject } from "react";
import type { CanvasWithHistory as FabricCanvas } from "@anth0nycodes/fabric-history";
import type { TPointerEvent } from "fabric";
import { captureAnnotatedPage } from "@/lib/capture";
import { getErrorMessage } from "@/lib/errors";

export { getErrorMessage };

declare global {
  interface NavigatorUA {
    getHighEntropyValues(platforms: string[]): Promise<{ platform: string }>;
  }

  interface Navigator {
    userAgentData?: NavigatorUA;
  }
}

/**
 * Resolves the operating system the browser is running on, used to label
 * OS-specific shortcuts (⌘C vs Ctrl+C).
 *
 * @returns The OS name — typically `"Windows"`, `"macOS"` or `"Linux"`, or
 * `"Unknown"` when the user agent can't be matched.
 */
export async function getOS() {
  // Grab browser OS with userAgentData
  if (navigator.userAgentData) {
    const ua = await navigator.userAgentData.getHighEntropyValues(["platform"]);
    return ua.platform;
  }

  // Fallback for browsers that don't yet support userAgentData
  const ua = window.navigator.userAgent.toLowerCase();

  if (ua.includes("win")) return "Windows";
  if (ua.includes("mac")) return "macOS";
  if (ua.includes("linux")) return "Linux";

  return "Unknown";
}

/**
 * Maps a pointer event to its position on the canvas.
 *
 * @param fc - The Fabric canvas the event fired on.
 * @param e - The originating pointer event.
 * @returns The event's `x`/`y` in canvas viewport space.
 */
export function getCanvasCoordinates(fc: FabricCanvas, e: TPointerEvent) {
  const { x, y } = fc.getViewportPoint(e);
  return { x, y };
}

/**
 * Copies the annotated page to the clipboard as a PNG.
 *
 * @param fcRef - Ref to the Fabric canvas.
 * @param toolbarRef - Ref to the toolbar root, hidden during the capture.
 * @returns Whether the image actually reached the clipboard. The write fails
 * when the document isn't focused, so the toolbar uses this to decide whether
 * to show its confirmation.
 */
export async function handleCopyToClipboard(
  fcRef: RefObject<FabricCanvas | null>,
  toolbarRef: RefObject<HTMLDivElement | null>
) {
  try {
    // Pass a Promise into ClipboardItem so the write is tied to this user
    // gesture. Full-page stitches can take longer than Chrome's ~5s transient
    // activation window; waiting to write afterwards would fail.
    const blobPromise = captureAnnotatedPage(fcRef, toolbarRef).then((blob) => {
      if (!blob) {
        throw new Error("Capture failed");
      }
      return blob;
    });
    await navigator.clipboard.write([
      new ClipboardItem({ "image/png": blobPromise }),
    ]);
    return true;
  } catch (error) {
    const errorMessage = getErrorMessage(error);
    console.error("Error copying to clipboard:", errorMessage);
    return false;
  }
}

/**
 * Downloads the annotated page as `tracemark-canvas.png`.
 *
 * @param fcRef - Ref to the Fabric canvas.
 * @param toolbarRef - Ref to the toolbar root, hidden during the capture.
 * @returns Whether the download was triggered.
 */
export async function handleExportAsPNG(
  fcRef: RefObject<FabricCanvas | null>,
  toolbarRef: RefObject<HTMLDivElement | null>
) {
  try {
    const blob = await captureAnnotatedPage(fcRef, toolbarRef);
    if (!blob) return false;
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = "tracemark-canvas.png";
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
    return true;
  } catch (error) {
    const errorMessage = getErrorMessage(error);
    console.error("Error exporting as PNG:", errorMessage);
    return false;
  }
}

/**
 * Removes every object from the canvas.
 *
 * @remarks
 * Uses the history-aware `clearCanvas()` rather than Fabric's `clear()`, so the
 * cleared state is recorded and the wipe stays undoable.
 *
 * @param fcRef - Ref to the Fabric canvas.
 * @returns Whether there was a mounted canvas to clear.
 */
export function handleClearCanvas(fcRef: RefObject<FabricCanvas | null>) {
  const fc = fcRef.current;
  if (!fc) return false;
  fc.clearCanvas();
  return true;
}
