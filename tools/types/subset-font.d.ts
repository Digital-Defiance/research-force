declare module 'subset-font' {
  interface SubsetOptions {
    readonly targetFormat?: 'sfnt' | 'woff' | 'woff2' | 'truetype';
    readonly preserveNameIds?: readonly number[];
    readonly variationAxes?: Readonly<Record<string, number | { readonly min: number; readonly max: number; readonly default?: number }>>;
    readonly noLayoutClosure?: boolean;
  }
  export default function subsetFont(font: Uint8Array, text: string, options?: SubsetOptions): Promise<Buffer>;
}
