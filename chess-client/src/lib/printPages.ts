// Printing a PDF the app built itself. The webview can only print what it
// draws, so the pages are drawn: PDF.js renders each one onto a canvas at
// printer resolution, the images go into a print-only layer at the end of the
// body (index.css hides everything else under @media print and hides the
// layer on screen), and the system's own print dialog does the rest. That
// dialog is the one with the printer list, copies and page ranges, which the
// app has no way of offering itself.
//
// pdfjs-dist is large and used only here, so it is fetched on first use.

import workerUrl from "pdfjs-dist/legacy/build/pdf.worker.min.mjs?url";

const HOST_ID = "lpdo-print";
/** Dots per inch the pages are drawn at. 220 keeps 9pt type crisp on paper
 *  while a dozen A4 pages stay within a few hundred MB while printing. */
const DPI = 220;

export async function printPdfPages(bytes: Uint8Array, onProgress?: (done: number, total: number) => void): Promise<void> {
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;
  const task = pdfjs.getDocument({ data: bytes });
  const doc = await task.promise;

  document.getElementById(HOST_ID)?.remove();
  const host = document.createElement("div");
  host.id = HOST_ID;
  const images: HTMLImageElement[] = [];
  for (let i = 1; i <= doc.numPages; i++) {
    const page = await doc.getPage(i);
    const viewport = page.getViewport({ scale: DPI / 72 });
    const canvas = document.createElement("canvas");
    canvas.width = Math.round(viewport.width);
    canvas.height = Math.round(viewport.height);
    await page.render({ canvas, canvasContext: canvas.getContext("2d")!, viewport }).promise;
    const img = document.createElement("img");
    img.src = canvas.toDataURL("image/png");
    img.alt = `Page ${i}`;
    images.push(img);
    host.appendChild(img);
    canvas.width = 0;                     // free the bitmap now, not at GC time
    onProgress?.(i, doc.numPages);
  }
  await task.destroy();
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
