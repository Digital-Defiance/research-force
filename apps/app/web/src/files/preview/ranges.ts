import { limited, readBounded, unavailable } from './transport';
import type { DownloadSource } from './transport';

/**
 * Ranged reads of one file through its Download_Link. Every byte that crosses the network counts against `budgetBytes`; the read that would
 * pass it fails as resource-limited instead of letting a large PDF fill the tab. `end` is exclusive, as PDF.js asks.
 */
export function rangeReader(source: DownloadSource, size: number, budgetBytes: number, signal: AbortSignal) {
  let transferred = 0;
  return {
    get transferred(): number { return transferred; },
    async read(begin: number, end: number): Promise<Uint8Array> {
      const last = Math.min(end, size);
      if (begin >= last) return new Uint8Array(0);
      if (transferred + (last - begin) > budgetBytes) throw limited('The PDF');
      const response = await source.fetch(signal, { start: begin, end: last - 1 });
      // A server that ignores Range answers 200 with the whole file; only the bytes asked for are kept, and never more than the budget.
      const whole = response.status !== 206;
      const { bytes } = await readBounded(response, whole ? last : last - begin);
      const chunk = whole ? bytes.slice(begin, last) : bytes;
      if (chunk.byteLength !== last - begin) throw unavailable();
      transferred += chunk.byteLength;
      return chunk;
    },
  };
}
