import type { RefObject } from "react";
import type { CanvasWithHistory as FabricCanvas } from "@anth0nycodes/fabric-history";
import { browser } from "#imports";
import { getErrorMessage } from "@/lib/errors";

const CAPTURE_SETTLE_MS = 120;
const CAPTURE_RETRY_DELAY_MS = 400;
const MAX_CAPTURE_ATTEMPTS = 5;
/** Browsers reject canvases much larger than this on a side. */
const MAX_OUTPUT_DIMENSION = 16384;
const FREEZE_OVERLAY_ATTR = "data-tracemark-capture-freeze";

let captureInProgress = false;

/**
 * True while a copy/export capture is running. The canvas scroll listener
 * skips growing the overlay during that window.
 */
export function isCaptureInProgress() {
  return captureInProgress;
}

/**
 * Waits until the browser has painted.
 *
 * @remarks
 * A single `requestAnimationFrame` callback still runs *before* the upcoming
 * paint, so two are chained to guarantee pending style changes are on screen
 * before continuing.
 *
 * @returns A promise that resolves after the next paint.
 */
function nextPaint() {
  return new Promise<void>((resolve) =>
    requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
  );
}

function delay(ms: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, ms));
}

function dataUrlToBlob(dataUrl: string) {
  return fetch(dataUrl).then((response) => {
    if (!response.ok) {
      throw new Error("Failed to read capture data");
    }
    return response.blob();
  });
}

function loadImage(dataUrl: string) {
  return new Promise<HTMLImageElement>((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("Failed to load captured frame"));
    img.src = dataUrl;
  });
}

function canvasToPngBlob(canvas: HTMLCanvasElement) {
  return new Promise<Blob>((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (blob) {
        resolve(blob);
        return;
      }
      reject(new Error("Failed to encode PNG"));
    }, "image/png");
  });
}

async function captureVisibleTabPngOnce() {
  const dataUrl: unknown = await browser.runtime.sendMessage({
    type: "CAPTURE_VISIBLE_TAB",
  });
  if (typeof dataUrl === "string" && dataUrl.startsWith("data:")) {
    return dataUrl;
  }
  throw new Error("Visible tab capture returned an empty result");
}

/**
 * Asks the background worker to screenshot the visible tab, retrying if Chrome
 * rate-limits `captureVisibleTab`.
 */
async function captureVisibleTabPng() {
  let lastError: unknown;

  for (let attempt = 0; attempt < MAX_CAPTURE_ATTEMPTS; attempt++) {
    try {
      return await captureVisibleTabPngOnce();
    } catch (error) {
      lastError = error;
      await delay(CAPTURE_RETRY_DELAY_MS * (attempt + 1));
    }
  }

  throw lastError instanceof Error
    ? lastError
    : new Error("Visible tab capture failed");
}

/**
 * True when any drawing extends above or below the current viewport.
 *
 * @remarks
 * Object positions are in document/canvas space (the overlay is pinned to the
 * top of the page), so they can be compared directly to `window.scrollY`.
 */
function hasDrawingsOutsideViewport(fc: FabricCanvas) {
  const viewportTop = window.scrollY;
  const viewportBottom = viewportTop + window.innerHeight;

  return fc.getObjects().some((object) => {
    if (!object.visible) return false;
    const { top, height } = object.getBoundingRect();
    return top < viewportTop - 1 || top + height > viewportBottom + 1;
  });
}

function hideCaptureUi(
  fc: FabricCanvas,
  toolbar: HTMLDivElement
): HTMLDivElement[] {
  const elementsToHide: HTMLDivElement[] = [toolbar];
  const root = toolbar.getRootNode();
  if (root instanceof ShadowRoot || root instanceof Document) {
    elementsToHide.push(
      ...root.querySelectorAll<HTMLDivElement>('[data-slot="popover-content"]')
    );
  }
  elementsToHide.forEach((el) => {
    el.style.display = "none";
  });
  fc.discardActiveObject();
  fc.requestRenderAll();
  return elementsToHide;
}

function restoreCaptureUi(elementsToHide: HTMLDivElement[]) {
  elementsToHide.forEach((el) => {
    el.style.display = "";
  });
}

function preventOverlayScroll(event: Event) {
  event.preventDefault();
}

/**
 * Pins a still of the current viewport over the tab so stitching can scroll
 * the real page underneath without the view jumping around.
 */
function mountFreezeOverlay(dataUrl: string) {
  const overlay = document.createElement("div");
  overlay.setAttribute(FREEZE_OVERLAY_ATTR, "");
  overlay.setAttribute("aria-hidden", "true");
  Object.assign(overlay.style, {
    position: "fixed",
    left: "0",
    top: "0",
    width: "100vw",
    height: "100vh",
    zIndex: "2147483647",
    background: "#000",
    cursor: "wait",
  });

  const img = document.createElement("img");
  img.src = dataUrl;
  img.alt = "";
  img.draggable = false;
  Object.assign(img.style, {
    width: "100%",
    height: "100%",
    objectFit: "fill",
    pointerEvents: "none",
    userSelect: "none",
  });
  overlay.appendChild(img);

  overlay.addEventListener("wheel", preventOverlayScroll, { passive: false });
  overlay.addEventListener("touchmove", preventOverlayScroll, {
    passive: false,
  });

  document.documentElement.appendChild(overlay);
  return overlay;
}

function removeFreezeOverlay(overlay: HTMLElement | null) {
  if (!overlay) return;
  overlay.removeEventListener("wheel", preventOverlayScroll);
  overlay.removeEventListener("touchmove", preventOverlayScroll);
  overlay.remove();
}

/**
 * Removes any freeze still left on the page. Called when Tracemark closes so
 * Esc / the toolbar toggle cannot leave a wait-cursor overlay behind.
 */
export function removeCaptureFreezeOverlays() {
  document
    .querySelectorAll<HTMLElement>(`[${FREEZE_OVERLAY_ATTR}]`)
    .forEach(removeFreezeOverlay);
}

/**
 * Scrolls and paints while the freeze overlay still covers the tab, then hides
 * it just long enough for one `captureVisibleTab` attempt so the real page is
 * visible. The still is restored before retry backoff, so a rate-limited first
 * slice does not uncover the jumped page or drop scroll locking.
 */
async function captureSliceBehindFreeze(overlay: HTMLElement) {
  let lastError: unknown;

  for (let attempt = 0; attempt < MAX_CAPTURE_ATTEMPTS; attempt++) {
    try {
      overlay.style.visibility = "hidden";
      await nextPaint();
      return await captureVisibleTabPngOnce();
    } catch (error) {
      lastError = error;
    } finally {
      overlay.style.visibility = "visible";
    }
    await delay(CAPTURE_RETRY_DELAY_MS * (attempt + 1));
  }

  throw lastError instanceof Error
    ? lastError
    : new Error("Visible tab capture failed");
}

/**
 * Scroll tops that cover `captureHeight` without scrolling past the last page
 * of the region. The last value is clamped so the canvas height listener does
 * not grow the overlay while we capture.
 */
export function getCaptureScrollTops(
  captureHeight: number,
  viewportHeight: number
) {
  const maxScroll = Math.max(0, captureHeight - viewportHeight);
  if (maxScroll === 0) return [0];

  const tops: number[] = [];
  let y = 0;
  while (y < maxScroll) {
    tops.push(y);
    y += viewportHeight;
  }
  tops.push(maxScroll);
  return tops;
}

async function stitchFullPageCapture(
  captureHeight: number,
  overlay: HTMLElement
) {
  const viewportHeight = window.innerHeight;
  const originalX = window.scrollX;
  const originalY = window.scrollY;
  const html = document.documentElement;
  const previousScrollBehavior = html.style.scrollBehavior;
  const previousOverflowAnchor = html.style.overflowAnchor;

  html.style.scrollBehavior = "auto";
  html.style.overflowAnchor = "none";

  try {
    const scrollTops = getCaptureScrollTops(captureHeight, viewportHeight);
    const frames: { img: HTMLImageElement; scrollY: number }[] = [];

    for (const top of scrollTops) {
      window.scrollTo({ left: originalX, top, behavior: "instant" });
      await nextPaint();
      await delay(CAPTURE_SETTLE_MS);

      const dataUrl = await captureSliceBehindFreeze(overlay);
      const img = await loadImage(dataUrl);
      frames.push({ img, scrollY: window.scrollY });
    }

    const firstFrame = frames[0];
    if (!firstFrame) {
      throw new Error("No frames captured");
    }

    const pxPerCss = firstFrame.img.width / window.innerWidth;
    let outputWidth = Math.round(window.innerWidth * pxPerCss);
    let outputHeight = Math.round(captureHeight * pxPerCss);
    let outputScale = pxPerCss;

    if (
      outputHeight > MAX_OUTPUT_DIMENSION ||
      outputWidth > MAX_OUTPUT_DIMENSION
    ) {
      const fit = Math.min(
        MAX_OUTPUT_DIMENSION / outputWidth,
        MAX_OUTPUT_DIMENSION / outputHeight
      );
      outputScale *= fit;
      outputWidth = Math.max(1, Math.round(outputWidth * fit));
      outputHeight = Math.max(1, Math.round(outputHeight * fit));
    }

    const output = document.createElement("canvas");
    output.width = outputWidth;
    output.height = outputHeight;
    const ctx = output.getContext("2d");
    if (!ctx) {
      throw new Error("Failed to create capture canvas");
    }
    ctx.imageSmoothingEnabled = false;

    for (const frame of frames) {
      const destY = Math.round(frame.scrollY * outputScale);
      const destW = Math.round(frame.img.width * (outputScale / pxPerCss));
      const destH = Math.round(frame.img.height * (outputScale / pxPerCss));
      ctx.drawImage(frame.img, 0, destY, destW, destH);
    }

    return await canvasToPngBlob(output);
  } finally {
    window.scrollTo({
      left: originalX,
      top: originalY,
      behavior: "instant",
    });
    html.style.scrollBehavior = previousScrollBehavior;
    html.style.overflowAnchor = previousOverflowAnchor;
  }
}

async function captureAnnotatedPageUnlocked(
  fcRef: RefObject<FabricCanvas | null>,
  toolbarRef: RefObject<HTMLDivElement | null>
) {
  const fc = fcRef.current;
  const toolbar = toolbarRef.current;
  if (!fc || !toolbar) return;

  let freezeOverlay: HTMLElement | null = null;
  let elementsToHide: HTMLDivElement[] = [];

  try {
    const captureHeight = fc.getHeight();
    const needsFullPage =
      captureHeight > window.innerHeight + 1 && hasDrawingsOutsideViewport(fc);

    if (needsFullPage) {
      const freezeFrame = await captureVisibleTabPng();
      freezeOverlay = mountFreezeOverlay(freezeFrame);
      await loadImage(freezeFrame);
      await nextPaint();
    }

    elementsToHide = hideCaptureUi(fc, toolbar);
    await nextPaint();

    if (needsFullPage && freezeOverlay) {
      return await stitchFullPageCapture(captureHeight, freezeOverlay);
    }

    const dataUrl = await captureVisibleTabPng();
    return await dataUrlToBlob(dataUrl);
  } catch (error) {
    console.error("Error capturing annotated page:", getErrorMessage(error));
  } finally {
    restoreCaptureUi(elementsToHide);
    removeFreezeOverlay(freezeOverlay);
  }
}

/**
 * Screenshots the tab with drawings, including regions above/below the viewport
 * when annotations live there.
 *
 * @remarks
 * Hides the toolbar and any open popover, drops the active selection so its
 * handles aren't baked into the image, waits for the paint, then asks the
 * background worker to capture. If drawings sit outside the viewport, a still
 * of the current view is pinned over the tab, the page is scrolled in
 * viewport-sized slices underneath it, and those frames are stitched into one
 * PNG. Hidden elements and the original scroll position are always restored
 * before the still is lifted, so the view does not jump.
 *
 * @param fcRef - Ref to the Fabric canvas.
 * @param toolbarRef - Ref to the toolbar root, also used to find the popovers
 * to hide.
 * @returns A PNG blob, or `undefined` if the canvas or toolbar isn't mounted
 * or the capture failed.
 */
export async function captureAnnotatedPage(
  fcRef: RefObject<FabricCanvas | null>,
  toolbarRef: RefObject<HTMLDivElement | null>
) {
  if (captureInProgress) return;

  captureInProgress = true;
  try {
    return await captureAnnotatedPageUnlocked(fcRef, toolbarRef);
  } finally {
    captureInProgress = false;
  }
}
