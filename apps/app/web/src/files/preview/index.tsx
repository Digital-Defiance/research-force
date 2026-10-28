import { lazy, Suspense, useCallback, useEffect, useState } from 'react';
import { fileExtension } from '@researchforce/domain/file-kinds';
import { TEXT_PREVIEW_BYTES } from '@researchforce/domain/files';
import { useApi } from '../../api';
import { Notice } from '../../ui';
import { ImagePreview } from './image';
import { imageMime, isPdf } from './magic';
import { previewCsv, previewText } from './truncate';
const PdfPreview = lazy(() => import('./pdf').then((module) => ({ default: module.PdfPreview })));
interface FileInfo { readonly id: string; readonly fileKind: string; readonly originalName: string; readonly sizeBytes: number }
/** Every fetch uses a Member-bound expiring Download_Link. Extracts and renderings live only in this tab. */
export function FilePreview({ file }: { readonly file: FileInfo }) {
  const client = useApi();
  const [bytes, setBytes] = useState<Uint8Array | null>(null);
  const [error, setError] = useState<string | null>(null);
  const fail = useCallback((cause: string) => setError(cause), []);
  const supported = ['pdf', 'text_log', 'csv'].includes(file.fileKind) || (file.fileKind === 'image' && ['jpg', 'jpeg', 'png', 'gif', 'webp'].includes(fileExtension(file.originalName)));
  useEffect(() => {
    const controller = new AbortController(); let active = true;
    setBytes(null); setError(null);
    if (supported) void (async () => {
      try {
        const link = await client.post<{ url: string }>(`/files/${file.id}/link`);
        const response = await fetch(link.url, { signal: controller.signal, credentials: 'omit', headers: file.fileKind === 'text_log' && file.sizeBytes > TEXT_PREVIEW_BYTES ? { Range: `bytes=0-${TEXT_PREVIEW_BYTES - 1}` } : {} });
        if (!response.ok) throw new Error('The file is unavailable from storage.');
        const data = new Uint8Array(await response.arrayBuffer());
        if (file.fileKind === 'pdf' && !isPdf(data)) throw new Error('The file does not match its recorded PDF format.');
        if (file.fileKind === 'image' && imageMime(data) === null) throw new Error('The file does not match its recorded image format.');
        if (active) setBytes(data);
      } catch (cause) { if (active) setError(cause instanceof Error ? cause.message : 'The file is unavailable from storage.'); }
    })();
    return () => { active = false; controller.abort(); };
  }, [client, file.id, file.fileKind, file.sizeBytes, supported]);
  if (!supported) return <Notice title="An inline preview is not available for this file type. The full file can be downloaded." />;
  if (error) return <Notice tone="warning" title={`Preview unavailable: ${error}`} />;
  if (!bytes) return <p role="status">Loading preview…</p>;
  if (file.fileKind === 'pdf') return <Suspense fallback={<p>Loading PDF preview…</p>}><PdfPreview bytes={bytes} onError={fail} /></Suspense>;
  if (file.fileKind === 'image') return <ImagePreview bytes={bytes} mime={imageMime(bytes)!} onError={fail} />;
  try {
    if (file.fileKind === 'text_log') { const text = previewText(bytes, file.sizeBytes); return <div><p>{`Showing ${text.shownBytes} of ${text.totalBytes} bytes`}</p><pre className="rf-file-text">{text.text}</pre></div>; }
    const csv = previewCsv(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
    return <div className="rf-file-table"><p>{`${csv.rowCount} rows shown. ${csv.hasMore ? 'More rows exist.' : 'There are no more rows.'}`}</p>
      <table><thead><tr>{csv.headers.map((header, i) => <th scope="col" key={i}>{header}</th>)}</tr></thead><tbody>{csv.rows.map((row, i) => <tr key={i}>{row.map((value, j) => <td key={j}>{value}</td>)}</tr>)}</tbody></table></div>;
  } catch (cause) { return <Notice tone="warning" title={`Preview unavailable: ${cause instanceof Error && cause.message.includes('format') ? cause.message : 'The file is damaged or does not contain valid UTF-8 text.'}`} />; }
}
