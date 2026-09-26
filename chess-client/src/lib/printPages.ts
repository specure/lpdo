// Drawing the pages of a PDF the app built itself — for the preview in the
// Print dialog, and for printing. The webview can only print what it draws,
// so printing draws: PDF.js renders each page onto a canvas at printer
// resolution, the images go into a print-only layer at the end of the body
// (index.css hides everything else under @media print and hides the layer on
// screen), and the system's own print dialog does the rest. That dialog is
// the one with the printer list, copies and page ranges, which the app has no
// way of offering itself.
//
// pdfjs-dist is large and used only here, so it is fetched on first use.

import workerUrl from "pdfjs-dist/legacy/build/pdf.worker.min.mjs?url";

const HOST_ID = "lpdo-print";
/** Dots per inch the pages are printed at. 220 keeps 9pt type crisp on paper
 *  while a dozen A4 pages stay within a few hundred MB while printing. */
const PRINT_DPI = 220;

/** Each page as a PNG data URL, drawn at `dpi`. `onPage` is told as each one
 *  is done, so a preview can show pages as they come. */
export async function renderPdfPages(
  bytes: Uint8Array,
  dpi: number,
  onPage?: (url: string, index: number, total: number) => void,
): Promise<string[]> {
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;
  // PDF.js takes the buffer over, so it gets a copy: the caller's bytes are
  // still the document to save or print.
  const task = pdfjs.getDocument({ data: bytes.slice() });
  const doc = await task.promise;
  const urls: string[] = [];
  try {
    for (let i = 1; i <= doc.numPages; i++) {
      const page = await doc.getPage(i);
      const viewport = page.getViewport({ scale: dpi / 72 });
      const canvas = document.createElement("canvas");
      canvas.width = Math.round(viewport.width);
      canvas.height = Math.round(viewport.height);
      await page.render({ canvas, canvasContext: canvas.getContext("2d")!, viewport }).promise;
      const url = canvas.toDataURL("image/png");
      canvas.width = 0;                     // free the bitmap now, not at GC time
      urls.push(url);
      onPage?.(url, i - 1, doc.numPages);
    }
  } finally {
    await task.destroy();
  }
  return urls;
}

export async function printPdfPages(bytes: Uint8Array, onProgress?: (done: number, total: number) => void): Promise<void> {
  document.getElementById(HOST_ID)?.remove();
  const host = document.createElement("div");
  host.id = HOST_ID;
  const images: HTMLImageElement[] = [];
  await renderPdfPages(bytes, PRINT_DPI, (url, i, total) => {
    const img = document.createElement("img");
    img.src = url;
    img.alt = `Page ${i + 1}`;
    images.push(img);
    host.appendChild(img);
    onProgress?.(i + 1, total);
  });
  document.body.appendChild(host);
  await Promise.all(images.map((img) => img.decode().catch(() => {})));

  // The layer stays until the dialog is done with it: `afterprint` fires when
  // the dialog closes on the engines that fire it, and the next print (or a
  // long timeout) clears it otherwise.
  const clear = () => { host.remove(); window.removeEventListener("afterprint", clear); };
  window.addEventListener("afterprint", clear);
  window.setTimeout(clear, 10 * 60 * 1000);

  // Tauri leaves window.print to the engine on Linux and Windows (WebKitGTK
  // and WebView2 both open the system dialog) and patches it in on macOS.
  window.print();
}
