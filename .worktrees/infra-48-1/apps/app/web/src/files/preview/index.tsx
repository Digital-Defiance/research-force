import { lazy, Suspense, useCallback, useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import { fileExtension } from '@researchforce/domain/file-kinds';
import { DEFAULT_RESOURCE_PROFILE } from '@researchforce/domain/resource-profile';
import { useApi } from '../../api';
import { Notice } from '../../ui';
import { previewCsvStream } from './csv-stream';
import type { CsvPreview } from './csv-stream';
import { ImagePreview } from './image';
import { imageDimensions, imageMime } from './magic';
import { previewText } from './truncate';
import { chunksOf, damaged, DownloadSource, limited, mismatch, PreviewError, readBounded, unavailable } from './transport';
const PdfPreview = lazy(() => import('./pdf').then((module) => ({ default: module.PdfPreview })));
interface FileInfo { readonly id: string; readonly fileKind: string; readonly originalName: string; readonly sizeBytes: number }
type Loaded = { readonly kind: 'text'; readonly text: ReturnType<typeof previewText> } | { readonly kind: 'csv'; readonly csv: CsvPreview } | { readonly kind: 'image'; readonly bytes: Uint8Array; readonly mime: string };
const RASTER = ['jpg', 'jpeg', 'png', 'gif', 'webp'];

const remainderText = (csv: CsvPreview): string => csv.remainder === 'more' ? 'More rows exist.'
  : csv.remainder === 'end' ? 'There are no more rows.'
  : `More rows may exist: the preview stopped at its ${csv.stoppedBy === 'scan' ? 'size' : csv.stoppedBy === 'record' ? 'record size' : 'memory'} limit before the end of the file.`;

/** Every byte is fetched through a Member-bound, expiring Download_Link, no more than the preview needs. Extracts and renderings live only in this tab. */
export function FilePreview({ file }: { readonly file: FileInfo }) {
  const client = useApi();
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [failure, setFailure] = useState<PreviewError | null>(null);
  const fail = useCallback((cause: PreviewError) => setFailure(cause), []);
  const supported = ['pdf', 'text_log', 'csv'].includes(file.fileKind) || (file.fileKind === 'image' && RASTER.includes(fileExtension(file.originalName)));
  const source = useMemo(() => new DownloadSource(client, file.id), [client, file.id]);
  const [limits, setLimits] = useState(DEFAULT_RESOURCE_PROFILE.chosen.preview);
  useEffect(() => {
    const controller = new AbortController(); let active = true;
    setLoaded(null); setFailure(null);
    if (!supported) return undefined;
    void (async () => {
      try {
        const preview = await client.resourceProfile().then((profile) => profile.chosen.preview, () => DEFAULT_RESOURCE_PROFILE.chosen.preview);
        if (active) setLimits(preview);
        if (file.fileKind === 'text_log') {
          const response = await source.fetch(controller.signal, file.sizeBytes > preview.textBytes ? { start: 0, end: preview.textBytes - 1 } : undefined);
          const { bytes } = await readBounded(response, preview.textBytes);
          if (active) setLoaded({ kind: 'text', text: previewText(bytes, file.sizeBytes) });
        } else if (file.fileKind === 'csv') {
          const response = await source.fetch(controller.signal);
          const csv = await previewCsvStream(chunksOf(response), { rows: preview.csvRows, scanBytes: preview.csvScanBytes, recordBytes: preview.csvRecordBytes, bufferBytes: preview.csvBufferBytes });
          if (active) setLoaded({ kind: 'csv', csv });
        } else if (file.fileKind === 'image') {
          if (file.sizeBytes > preview.rasterDecodedBytes) throw limited('The image');
          const { bytes, truncated } = await readBounded(await source.fetch(controller.signal), file.sizeBytes);
          const mime = imageMime(bytes);
          if (mime === null || truncated) throw mismatch('image');
          const size = imageDimensions(bytes);
          if (size === null || size.width < 1 || size.height < 1) throw damaged('The image');
          if (size.width * size.height * 4 > preview.rasterDecodedBytes) throw limited('The image');
          if (active) setLoaded({ kind: 'image', bytes, mime });
        }
      } catch (cause) {
        if (!active) return;
        setFailure(cause instanceof PreviewError ? cause : cause instanceof TypeError && /utf-?8|decode/iu.test(cause.message) ? new PreviewError('damaged', 'The file does not contain valid UTF-8 text.') : unavailable());
      }
    })();
    return () => { active = false; controller.abort(); };
  }, [client, source, file.id, file.fileKind, file.sizeBytes, supported]);
  if (!supported) return <Notice title="An inline preview is not available for this file type. The full file can be downloaded." />;
  if (failure) return <Notice tone="warning" title={`Preview unavailable: ${failure.message}`} />;
  if (file.fileKind === 'pdf') return <Suspense fallback={<p>Loading PDF preview…</p>}><PdfPreview source={source} size={file.sizeBytes} cacheBytes={limits.pdfCacheBytes} rasterBytes={limits.rasterDecodedBytes} onError={fail} /></Suspense>;
  if (!loaded) return <p role="status">Loading preview…</p>;
  return rendered(loaded, fail);
}
function rendered(loaded: Loaded, fail: (cause: PreviewError) => void): ReactNode {
  if (loaded.kind === 'image') return <ImagePreview bytes={loaded.bytes} mime={loaded.mime} onError={fail} />;
  if (loaded.kind === 'text') return <div><p>{`Showing ${loaded.text.shownBytes} of ${loaded.text.totalBytes} bytes`}</p><pre className="rf-file-text">{loaded.text.text}</pre></div>;
  const { csv } = loaded;
  return <div className="rf-file-table"><p>{`${csv.rows.length} rows shown. ${remainderText(csv)}`}</p>
    <table><thead><tr>{csv.headers.map((header, i) => <th scope="col" key={i}>{header}</th>)}</tr></thead><tbody>{csv.rows.map((row, i) => <tr key={i}>{row.map((value, j) => <td key={j}>{value}</td>)}</tr>)}</tbody></table></div>;
}
