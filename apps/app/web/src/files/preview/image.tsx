import { useEffect, useRef, useState } from 'react';
import { Button } from '../../ui';
import { damaged } from './transport';
import type { PreviewError } from './transport';
export function ImagePreview({ bytes, mime, onError }: { readonly bytes: Uint8Array; readonly mime: string; readonly onError: (cause: PreviewError) => void }) {
  const [url, setUrl] = useState('');
  const [zoom, setZoom] = useState<number | null>(null);
  const frame = useRef<HTMLDivElement>(null);
  const drag = useRef<{ x: number; y: number; left: number; top: number } | null>(null);
  useEffect(() => { const objectUrl = URL.createObjectURL(new Blob([bytes.slice().buffer], { type: mime })); setUrl(objectUrl); return () => URL.revokeObjectURL(objectUrl); }, [bytes, mime]);
  return <div className="rf-stack"><div className="rf-actions"><Button onClick={() => setZoom(null)}>Fit image</Button>
    {[100, 200, 300, 400].map((value) => <Button key={value} onClick={() => setZoom(value)}>{`${value}%`}</Button>)}</div>
    <div ref={frame} className="rf-file-image" tabIndex={0} aria-label="Image preview. Use arrow keys or drag to pan."
      onKeyDown={(event) => { const delta = { ArrowLeft: [-40, 0], ArrowRight: [40, 0], ArrowUp: [0, -40], ArrowDown: [0, 40] }[event.key]; if (delta) { event.preventDefault(); event.currentTarget.scrollLeft += delta[0]!; event.currentTarget.scrollTop += delta[1]!; } }}
      onPointerDown={(event) => { event.currentTarget.setPointerCapture(event.pointerId); drag.current = { x: event.clientX, y: event.clientY, left: event.currentTarget.scrollLeft, top: event.currentTarget.scrollTop }; }}
      onPointerMove={(event) => { if (drag.current) { event.currentTarget.scrollLeft = drag.current.left + drag.current.x - event.clientX; event.currentTarget.scrollTop = drag.current.top + drag.current.y - event.clientY; } }}
      onPointerUp={() => { drag.current = null; }} onPointerCancel={() => { drag.current = null; }}>
      {url && <img src={url} draggable={false} className={zoom === null ? 'rf-file-image-fit' : 'rf-file-image-zoom'} style={zoom === null ? undefined : { zoom: zoom / 100 }} alt="Attachment preview" onError={() => onError(damaged('The image'))} />}
    </div></div>;
}
