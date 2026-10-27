/** Neutral, unescaped data. Renderers escape text/attributes at the output boundary. */
export type AttributeValue = string | number | boolean | undefined;
export interface TextNode { readonly kind: 'text'; readonly value: string; }
export interface ElementNode {
  readonly kind: 'element';
  readonly tag: string;
  readonly attributes: Readonly<Record<string, AttributeValue>>;
  readonly children: readonly ViewNode[];
  readonly namespace?: 'html' | 'mathml' | 'svg';
}
export interface FragmentNode { readonly kind: 'fragment'; readonly children: readonly ViewNode[]; }
export type ViewNode = TextNode | ElementNode | FragmentNode;

export function text(value: string): TextNode { return { kind: 'text', value }; }
export function element(tag: string, attributes: Readonly<Record<string, AttributeValue>> = {}, children: readonly ViewNode[] = []): ElementNode {
  return { kind: 'element', tag, attributes: { ...attributes }, children: [...children] };
}
export function fragment(children: readonly ViewNode[]): FragmentNode { return { kind: 'fragment', children: [...children] }; }
