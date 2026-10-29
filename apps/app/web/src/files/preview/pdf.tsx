import { useEffect, useRef, useState } from 'react';
import { getDocument, GlobalWorkerOptions, PDFDataRangeTransport } from 'pdfjs-dist';
import type { PDFDocumentProxy } from 'pdfjs-dist';
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import { Button } from '../../ui';
import { rangeReader } from './ranges';
import { damaged, mismatch, PreviewError } from './transport';
import type { DownloadSource } from './transport';
import { isPdf } from './magic';
GlobalWorkerOptions.workerSrc = workerUrl;

const CHUNK = 65_536;
/** Pages are drawn at 1.25 times their size, smaller when the canvas would pass the decoded-image budget. */
export function pageScale(width: number, height: number, rasterBytes: number, wanted = 1.25): number {
  const pixels = width * height * wanted * wanted * 4;
  return pixels <= rasterBytes ? wanted : wanted * Math.sqrt(rasterBytes / pixels);
}

/**
 * Canvas-only rendering of a PDF read by range through the Member's Download_Link: no annotation layer, scripting, XFA, external resources or links, and
 * no eval (PDF.js 6 has none). Only the bytes PDF.js asks for are transferred, within `cacheBytes`.
 */
export function PdfPreview({ source, size, cacheBytes, rasterBytes, onError }: {
  readonly source: DownloadSource; readonly size: number; readonly cacheBytes: number; readonly rasterBytes: number; readonly onError: (cause: PreviewError) => void;
}) {
  const [document, setDocument] = useState<PDFDocumentProxy | null>(null);
  const [page, setPage] = useState(1);
  const canvas = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const controller = new AbortController(); let active = true;
    const fail = (error: unknown) => { if (active) onError(error instanceof PreviewError ? error : damaged('The PDF')); };
    const reader = rangeReader(source, size, cacheBytes, controller.signal);
    let task: ReturnType<typeof getDocument> | undefined;
    void (async () => {
      try {
        const initial = await reader.read(0, Math.min(CHUNK, size));
        if (!isPdf(initial)) throw mismatch('PDF');
        class Transport extends PDFDataRangeTransport {
          override requestDataRange(begin: number, end: number): void { reader.read(begin, end).then((chunk) => { if (active) this.onDataRange(begin, chunk); }, fail); }
        }
        task = getDocument({ range: new Transport(size, initial), rangeChunkSize: CHUNK, disableStream: true, disableAutoFetch: true, useSystemFonts: true, useWorkerFetch: false, disableFontFace: true, enableXfa: false, stopAtErrors: true });
        task.promise.then((doc) => { if (active) setDocument(doc); }, (error: unknown) => {
          fail(error instanceof Error && error.name === 'PasswordException' ? new PreviewError('password', 'The PDF is password-protected.') : error);
        });
      } catch (error) { fail(error); }
    })();
    return () => { active = false; controller.abort(); if (task) void task.destroy(); };
  }, [source, size, cacheBytes, onError]);
  useEffect(() => {
    let active = true; let rendering: { cancel(): void; promise: Promise<void> } | undefined;
    if (document && canvas.current) void document.getPage(page).then((pdfPage) => {
      if (!active || !canvas.current) return;
      const natural = pdfPage.getViewport({ scale: 1 });
      const viewport = pdfPage.getViewport({ scale: pageScale(natural.width, natural.height, rasterBytes) });
      canvas.current.width = Math.floor(viewport.width); canvas.current.height = Math.floor(viewport.height);
      rendering = pdfPage.render({ canvas: canvas.current, viewport, annotationMode: 0 });
      void rendering.promise.catch((error: unknown) => { if (active && !(error instanceof Error && error.name === 'RenderingCancelledException')) onError(damaged('The PDF page')); });
    }, (error: unknown) => { if (active) onError(error instanceof PreviewError ? error : damaged('The PDF page')); });
    return () => { active = false; rendering?.cancel(); };
  }, [document, page, rasterBytes, onError]);
  return <div className="rf-stack"><div className="rf-actions">
    <Button disabled={page <= 1} onClick={() => setPage((n) => n - 1)}>Previous page</Button>
    <span>{`Page ${page} of ${document?.numPages ?? '…'}`}</span>
    <Button disabled={!document || page >= document.numPages} onClick={() => setPage((n) => n + 1)}>Next page</Button>
    <label>Go to page <input type="number" min={1} max={document?.numPages ?? 1} value={page} onChange={(event) => { const n = Number(event.target.value); if (Number.isInteger(n) && n >= 1 && n <= (document?.numPages ?? 1)) setPage(n); }} /></label>
  </div><canvas className="rf-file-pdf" ref={canvas} aria-label={`PDF page ${page}`} /></div>;
}
