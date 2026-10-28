import { useEffect, useRef, useState } from 'react';
import { getDocument, GlobalWorkerOptions } from 'pdfjs-dist';
import type { PDFDocumentProxy } from 'pdfjs-dist';
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import { Button } from '../../ui';
GlobalWorkerOptions.workerSrc = workerUrl;
/** PDF.js 6 removed eval-based compilation. Canvas-only rendering: no annotation layer, JavaScript actions, external resources, or PDF links. */
export function PdfPreview({ bytes, onError }: { readonly bytes: Uint8Array; readonly onError: (cause: string) => void }) {
  const [document, setDocument] = useState<PDFDocumentProxy | null>(null);
  const [page, setPage] = useState(1);
  const canvas = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    let active = true;
    const task = getDocument({ data: bytes.slice(), useSystemFonts: true, useWorkerFetch: false, disableFontFace: true, enableXfa: false, stopAtErrors: true });
    task.promise.then((doc) => { if (active) setDocument(doc); }, (error: unknown) => {
      if (active) onError(error instanceof Error && error.name === 'PasswordException' ? 'The PDF is password-protected.' : 'The PDF is damaged.');
    });
    return () => { active = false; void task.destroy(); };
  }, [bytes, onError]);
  useEffect(() => {
    let active = true; let rendering: { cancel(): void; promise: Promise<void> } | undefined;
    if (document && canvas.current) void document.getPage(page).then((pdfPage) => {
      if (!active || !canvas.current) return;
      const viewport = pdfPage.getViewport({ scale: 1.25 });
      canvas.current.width = viewport.width; canvas.current.height = viewport.height;
      rendering = pdfPage.render({ canvas: canvas.current, viewport, annotationMode: 0 });
      void rendering.promise.catch((error: unknown) => { if (active && !(error instanceof Error && error.name === 'RenderingCancelledException')) onError('The PDF page is damaged.'); });
    }, () => { if (active) onError('The PDF page is damaged.'); });
    return () => { active = false; rendering?.cancel(); };
  }, [document, page, onError]);
  return <div className="rf-stack"><div className="rf-actions">
    <Button disabled={page <= 1} onClick={() => setPage((n) => n - 1)}>Previous page</Button>
    <span>{`Page ${page} of ${document?.numPages ?? '…'}`}</span>
    <Button disabled={!document || page >= document.numPages} onClick={() => setPage((n) => n + 1)}>Next page</Button>
    <label>Go to page <input type="number" min={1} max={document?.numPages ?? 1} value={page} onChange={(event) => { const n = Number(event.target.value); if (Number.isInteger(n) && n >= 1 && n <= (document?.numPages ?? 1)) setPage(n); }} /></label>
  </div><canvas className="rf-file-pdf" ref={canvas} aria-label={`PDF page ${page}`} /></div>;
}
