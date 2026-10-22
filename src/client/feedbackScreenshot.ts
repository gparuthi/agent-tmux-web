const CAPTURE_TIMEOUT_MS = 8000;
const MAX_SCALE = 2;

export const FEEDBACK_SCREENSHOT_NAME = "atw-feedback.png";

// Renders atw's own DOM to a PNG; the caller closes any menu or sheet first so it is not in the picture.
export async function captureFeedbackScreenshot(): Promise<Blob> {
  // Loaded on demand: a same-origin chunk, so the CSP stays as it is.
  const { default: html2canvas } = await import("html2canvas");
  const canvas = await Promise.race([
    html2canvas(document.body, {
      backgroundColor: getComputedStyle(document.body).backgroundColor,
      logging: false,
      scale: Math.min(window.devicePixelRatio || 1, MAX_SCALE),
      windowWidth: document.documentElement.clientWidth,
      windowHeight: window.innerHeight
    }),
    new Promise<never>((_, reject) => setTimeout(() => reject(new Error("Screenshot timed out")), CAPTURE_TIMEOUT_MS))
  ]);
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => blob ? resolve(blob) : reject(new Error("Screenshot was empty")), "image/png");
  });
}

// The hashed bundle name (index-<hash>.js) tells which deploy a phone is running.
export function readBundleId(doc: Pick<Document, "querySelector"> = document): string {
  const src = doc.querySelector('script[type="module"][src*="/assets/"]')?.getAttribute("src") ?? "";
  return src.split("/").pop() ?? "";
}
