import { createElement, Fragment, type Key, type ReactNode } from 'react';
import type { AttributeValue, ElementNode, ViewNode } from '@researchforce/domain/tree';
import { BOOLEAN_ATTRIBUTES, isEmptyUrlAttribute } from './render-string';

/** HTML attribute names whose React prop names differ. */
const PROP_NAMES: Readonly<Record<string, string>> = {
  class: 'className', for: 'htmlFor', tabindex: 'tabIndex', colspan: 'colSpan', rowspan: 'rowSpan', readonly: 'readOnly', maxlength: 'maxLength',
  minlength: 'minLength', autocomplete: 'autoComplete', autofocus: 'autoFocus', datetime: 'dateTime', srcset: 'srcSet', hreflang: 'hrefLang',
  enctype: 'encType', novalidate: 'noValidate', spellcheck: 'spellCheck', inputmode: 'inputMode', enterkeyhint: 'enterKeyHint',
  contenteditable: 'contentEditable', crossorigin: 'crossOrigin', 'accept-charset': 'acceptCharset', 'http-equiv': 'httpEquiv', charset: 'charSet',
  referrerpolicy: 'referrerPolicy', fetchpriority: 'fetchPriority', formaction: 'formAction', formmethod: 'formMethod', formnovalidate: 'formNoValidate',
  accesskey: 'accessKey', itemprop: 'itemProp', itemscope: 'itemScope', itemtype: 'itemType', playsinline: 'playsInline', usemap: 'useMap',
};
const FORM_VALUE = new Set(['input', 'select', 'textarea']);

function props(node: ElementNode, key: Key | undefined): Record<string, unknown> {
  const result: Record<string, unknown> = key === undefined ? {} : { key };
  const html = node.namespace !== 'mathml' && node.namespace !== 'svg';
  for (const [name, value] of Object.entries(node.attributes) as [string, AttributeValue][]) {
    if (/^on/iu.test(name) || name.toLowerCase() === 'style') throw new TypeError(`Attribute not allowed: ${name}`);
    const lower = name.toLowerCase();
    const boolean = html && BOOLEAN_ATTRIBUTES.has(lower);
    if (boolean ? !value : value === undefined || value === false || isEmptyUrlAttribute(node, name, value)) continue;
    let prop = html ? PROP_NAMES[lower] ?? name : lower === 'class' ? 'className' : name;
    if (FORM_VALUE.has(node.tag) && lower === 'value') prop = 'defaultValue';
    if (node.tag === 'input' && lower === 'checked') prop = 'defaultChecked';
    result[prop] = boolean ? true : value === true ? '' : value;
  }
  return result;
}

const textOf = (nodes: readonly ViewNode[]): string => nodes.map((node) => (node.kind === 'text' ? node.value : node.kind === 'fragment' ? textOf(node.children) : textOf(node.children))).join('');

/** Option values marked selected, which React takes as the select's `defaultValue` instead of a `selected` attribute. */
function selectedValues(nodes: readonly ViewNode[]): string[] {
  return nodes.flatMap((node): string[] => {
    if (node.kind === 'text') return [];
    if (node.kind === 'element' && node.tag === 'option') {
      return node.attributes['selected'] === true ? [String(node.attributes['value'] ?? textOf(node.children))] : [];
    }
    return selectedValues(node.children);
  });
}

function withoutSelected(node: ViewNode): ViewNode {
  if (node.kind === 'text') return node;
  if (node.kind === 'fragment') return { ...node, children: node.children.map(withoutSelected) };
  const attributes = node.tag === 'option' ? { ...node.attributes, selected: undefined } : node.attributes;
  return { ...node, attributes, children: node.children.map(withoutSelected) };
}

/** Renders a neutral element tree as React elements for the Workspace, with the same markup and classes as `renderToString` (R45.1). */
export function toReact(node: ViewNode, key?: Key): ReactNode {
  switch (node.kind) {
    case 'text': return node.value;
    case 'fragment': return createElement(Fragment, key === undefined ? null : { key }, ...node.children.map((child, index) => toReact(child, index)));
    case 'element': {
      const elementProps = props(node, key);
      if (node.tag === 'textarea') return createElement('textarea', { ...elementProps, defaultValue: textOf(node.children) });
      let children = node.children;
      if (node.tag === 'select') {
        const selected = selectedValues(children);
        if (selected.length > 0) elementProps['defaultValue'] = node.attributes['multiple'] === true ? selected : selected[0];
        children = children.map(withoutSelected);
      }
      return createElement(node.tag, elementProps, ...children.map((child, index) => toReact(child, index)));
    }
  }
}
