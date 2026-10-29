import type { Literal } from 'mdast';
import type { Extension as FromMarkdownExtension } from 'mdast-util-from-markdown';
import { asciiDigit, markdownLineEnding, markdownLineEndingOrSpace, unicodeWhitespace } from 'micromark-util-character';
import type { Code, Construct, Effects, Extension, State, TokenizeContext } from 'micromark-util-types';
import temml from 'temml';
import { element, text } from '@researchforce/domain/tree';
import type { AttributeValue, ElementNode, ViewNode } from '@researchforce/domain/tree';

declare module 'micromark-util-types' {
  interface TokenTypeMap { mathText: 'mathText'; mathTextSequence: 'mathTextSequence'; mathTextData: 'mathTextData' }
}
declare module 'mdast' {
  /** `$…$` (inline) or `$$…$$` (display) mathematics; `value` is the LaTeX between the delimiters. */
  interface InlineMath extends Literal { type: 'inlineMath'; display: boolean }
  interface PhrasingContentMap { inlineMath: InlineMath }
  interface RootContentMap { inlineMath: InlineMath }
}

const DOLLAR = 36;
/** micromark gives tabs, virtual spaces, and line endings negative codes, which `unicodeWhitespace` does not cover. */
const isSpace = (code: Code): boolean => code === null || markdownLineEndingOrSpace(code) || unicodeWhitespace(code);

/** Matches a closing `$` of inline mathematics: one not directly followed by a digit (R45.15). */
const inlineClose: Construct = {
  partial: true,
  tokenize(effects, ok, nok) {
    return (code) => {
      effects.enter('mathTextSequence');
      effects.consume(code);
      effects.exit('mathTextSequence');
      return (next) => (asciiDigit(next) ? nok(next) : ok(next));
    };
  },
};
const displayClose: Construct = {
  partial: true,
  tokenize(effects, ok, nok) {
    return (code) => {
      effects.enter('mathTextSequence');
      effects.consume(code);
      return (next) => {
        if (next !== DOLLAR) return nok(next);
        effects.consume(next);
        effects.exit('mathTextSequence');
        return ok;
      };
    };
  },
};

/**
 * `$…$` opens only before a character other than whitespace and closes at the first `$` that follows such a character and is not followed by a digit;
 * `$$…$$` closes at the first `$$` and needs content other than whitespace. Code spans take precedence because they start earlier; failed openers stay as written.
 */
function tokenizeMath(this: TokenizeContext, effects: Effects, ok: State, nok: State): State {
  let display = false;
  let last: Code = null;
  let inData = false;
  let blank = true;

  const openData = (): void => { if (!inData) { effects.enter('mathTextData'); inData = true; } };
  const closeData = (): void => { if (inData) { effects.exit('mathTextData'); inData = false; } };
  const lineEnding = (code: Code, then: State): State | undefined => {
    closeData();
    effects.enter('lineEnding');
    effects.consume(code);
    effects.exit('lineEnding');
    last = code;
    return then;
  };

  const start: State = (code) => {
    effects.enter('mathText');
    effects.enter('mathTextSequence');
    effects.consume(code);
    return afterFirst;
  };
  const afterFirst: State = (code) => {
    if (code === DOLLAR) {
      effects.consume(code);
      effects.exit('mathTextSequence');
      display = true;
      return content;
    }
    effects.exit('mathTextSequence');
    if (isSpace(code)) return nok(code);
    return content(code);
  };
  const content: State = (code) => {
    if (code === null) return nok(code);
    if (markdownLineEnding(code)) return lineEnding(code, content);
    if (code === DOLLAR) {
      if (display) return effects.check(displayClose, closeDisplay, asData)(code);
      if (!isSpace(last)) return effects.check(inlineClose, closeInline, asData)(code);
    }
    return asData(code);
  };
  const asData: State = (code) => {
    openData();
    effects.consume(code);
    if (!isSpace(code)) blank = false;
    last = code;
    return content;
  };
  const closeInline: State = (code) => {
    closeData();
    effects.enter('mathTextSequence');
    effects.consume(code);
    effects.exit('mathTextSequence');
    effects.exit('mathText');
    return ok;
  };
  const closeDisplay: State = (code) => {
    if (blank) return nok(code);
    closeData();
    effects.enter('mathTextSequence');
    effects.consume(code);
    return (next) => {
      effects.consume(next);
      effects.exit('mathTextSequence');
      effects.exit('mathText');
      return ok;
    };
  };
  return start;
}

const mathConstruct: Construct = { name: 'mathText', tokenize: tokenizeMath };

/** The micromark syntax extension for R45.15 mathematics. */
export function math(): Extension { return { text: { [DOLLAR]: mathConstruct } }; }

/** Builds `inlineMath` nodes holding the exact LaTeX between the delimiters. */
export function mathFromMarkdown(): FromMarkdownExtension {
  return {
    enter: { mathText(token) { this.enter({ type: 'inlineMath', value: '', display: false }, token); } },
    exit: {
      mathText(token) {
        const raw = this.sliceSerialize(token);
        const display = raw.startsWith('$$');
        const node = this.stack.at(-1) as { value: string; display: boolean };
        node.value = display ? raw.slice(2, -2) : raw.slice(1, -1);
        node.display = display;
        this.exit(token);
      },
    },
  };
}

const ENTITIES: Readonly<Record<string, string>> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: '\u00a0' };
function decodeEntities(value: string): string {
  return value.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/giu, (whole, name: string) => {
    if (name.startsWith('#x') || name.startsWith('#X')) return String.fromCodePoint(Number.parseInt(name.slice(2), 16));
    if (name.startsWith('#')) return String.fromCodePoint(Number.parseInt(name.slice(1), 10));
    return ENTITIES[name] ?? whole;
  });
}

/**
 * Reads Temml's well-formed MathML into the neutral tree. Inline `style` attributes are dropped because the
 * Content-Security-Policy forbids them; Temml's classes carry the same layout.
 */
export function parseMathML(markup: string): ElementNode {
  const stack: { tag: string; attributes: Record<string, AttributeValue>; children: ViewNode[] }[] = [{ tag: '#root', attributes: {}, children: [] }];
  const pattern = /<(\/?)([a-zA-Z][\w:-]*)((?:\s+[\w:-]+="[^"]*")*)\s*(\/?)>|([^<]+)/gu;
  for (const match of markup.matchAll(pattern)) {
    const [, closing, tag, attributeText, selfClosing, textValue] = match;
    const top = stack.at(-1)!;
    if (textValue !== undefined) { top.children.push(text(decodeEntities(textValue))); continue; }
    if (closing) {
      const done = stack.pop()!;
      if (done.tag !== tag) throw new Error(`Unbalanced MathML: </${tag}> closes <${done.tag}>.`);
      stack.at(-1)!.children.push({ ...element(done.tag, done.attributes, done.children), namespace: 'mathml' });
      continue;
    }
    const attributes: Record<string, AttributeValue> = {};
    for (const [, name, value] of (attributeText ?? '').matchAll(/([\w:-]+)="([^"]*)"/gu)) if (name !== 'style') attributes[name!] = decodeEntities(value!);
    if (selfClosing) top.children.push({ ...element(tag!, attributes), namespace: 'mathml' });
    else stack.push({ tag: tag!, attributes, children: [] });
  }
  const [only, ...rest] = stack[0]!.children;
  if (stack.length !== 1 || rest.length || only?.kind !== 'element') throw new Error('Temml returned unexpected markup.');
  return only;
}

/** MathML for the expression, or its source with delimiters when it cannot be rendered (R45.15). */
export function renderMath(tex: string, display: boolean): ViewNode {
  try {
    return parseMathML(temml.renderToString(tex, { displayMode: display, throwOnError: true, annotate: true }));
  } catch {
    const delimiter = display ? '$$' : '$';
    return element('span', { class: 'math-source' }, [text(`${delimiter}${tex}${delimiter}`)]);
  }
}
