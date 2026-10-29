import { readFileSync, readdirSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import ts from 'typescript';
import { FIXED_TEXTS } from '@researchforce/design/fixed-texts';

/**
 * Copy lint (R45.14, R46.3, R46.10): fixed texts and templates use typographic quotation marks and apostrophes and hold no email address, telephone
 * number, postal address, or wording that asks for or offers money; prose in source string literals, which becomes generated text, uses typographic
 * quotation marks too.
 */

export interface CopyIssue { readonly where: string; readonly rule: string; readonly excerpt: string }

const STRAIGHT_QUOTE = /["']/u;
const EMAIL = /[^\s@<>()]+@[^\s@<>()]+\.[A-Za-z]{2,}/u;
const PHONE = /(?:\+\d{1,3}[\s.-]?)?(?:\(\d{1,4}\)[\s.-]?)?\d{2,4}(?:[\s.-]\d{2,4}){1,4}/gu;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/u;
const POSTAL = [
  /\b\d{1,5}\s+(?:[A-Z][a-z]+\s+){1,3}(?:Street|St|Road|Rd|Avenue|Ave|Lane|Ln|Boulevard|Blvd|Drive|Dr|Way|Court|Ct|Place|Pl|Square|Sq|Straße|Strasse|Weg|Platz)\b\.?/u,
  /\bP\.?\s?O\.?\s+Box\b/iu,
  /\b[A-Z]{1,2}\d[A-Z\d]?\s\d[A-Z]{2}\b/u,
  /\b[A-Z]{2}\s\d{5}(?:-\d{4})?\b/u,
];
const MONEY = /\b(?:donat\w*|fundrais\w*|crowdfund\w*|sponsor\w*|pay(?:s|ing|ment|ments|pal)?|patreon|ko-fi|tip jar|buy me a coffee|give money|send money|contribute money|support us financially)\b/giu;
const NEGATION = /\b(?:no|not|never|without|nor)\b/iu;

const excerptOf = (value: string, index: number, length: number): string => value.slice(Math.max(0, index - 20), index + length + 20).replace(/\s+/gu, ' ');

/** Issues in one piece of fixed or template text. */
export function fixedTextIssues(where: string, value: string): CopyIssue[] {
  const issues: CopyIssue[] = [];
  const quote = STRAIGHT_QUOTE.exec(value);
  if (quote) issues.push({ where, rule: 'Use typographic quotation marks and apostrophes (‘ ’ “ ”).', excerpt: excerptOf(value, quote.index, 1) });
  const email = EMAIL.exec(value);
  if (email) issues.push({ where, rule: 'Fixed texts hold no email address.', excerpt: excerptOf(value, email.index, email[0].length) });
  for (const match of value.matchAll(PHONE)) {
    if (!ISO_DATE.test(match[0]) && (match[0].match(/\d/gu) ?? []).length >= 7) issues.push({ where, rule: 'Fixed texts hold no telephone number.', excerpt: excerptOf(value, match.index, match[0].length) });
  }
  for (const pattern of POSTAL) {
    const match = pattern.exec(value);
    if (match) issues.push({ where, rule: 'Fixed texts hold no postal address.', excerpt: excerptOf(value, match.index, match[0].length) });
  }
  for (const match of value.matchAll(MONEY)) {
    const before = value.slice(0, match.index).split(/[.;:!?]/u).pop() ?? '';
    const lastWords = before.trim().split(/\s+/u).slice(-3).join(' ');
    if (!NEGATION.test(lastWords)) issues.push({ where, rule: 'No wording that asks for or offers money.', excerpt: excerptOf(value, match.index, match[0].length) });
  }
  return issues;
}

const CODE_LIKE = /[=<>{};|\\`]|--|^\s*(?:SELECT|INSERT|UPDATE|DELETE|CREATE|ALTER|DROP|WITH)\b/u;
const PROSE = /\p{L}+\s+\p{L}+\s+\p{L}+/u;
const APOSTROPHE = /\p{L}'\p{L}/u;
const QUOTED = /(?:^|[\s(])(["'])[^"'\s][^"']*\1(?=$|[\s.,;:!?)])/u;

/** Prose string literals in a source file that use straight quotation marks or apostrophes. */
export function proseLiteralIssues(fileName: string, source: string): CopyIssue[] {
  const file = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, fileName.endsWith('x') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const issues: CopyIssue[] = [];
  const check = (node: ts.Node, value: string): void => {
    if (!PROSE.test(value) || CODE_LIKE.test(value)) return;
    if (!APOSTROPHE.test(value) && !QUOTED.test(value)) return;
    const { line } = file.getLineAndCharacterOfPosition(node.getStart(file));
    issues.push({ where: `${fileName}:${line + 1}`, rule: 'Use typographic quotation marks and apostrophes (‘ ’ “ ”) in text shown to people.', excerpt: value.slice(0, 80) });
  };
  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) return;
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) check(node, node.text);
    else if (ts.isTemplateHead(node) || ts.isTemplateMiddle(node) || ts.isTemplateTail(node)) check(node, node.text);
    else if (ts.isJsxText(node)) check(node, node.text);
    ts.forEachChild(node, visit);
  };
  visit(file);
  return issues;
}

const root = fileURLToPath(new URL('..', import.meta.url));
const SOURCE_DIRS = [/^packages\/[^/]+\/src\//u, /^apps\/[^/]+\/(?:web\/)?src\//u];
const TEMPLATE = /(?:^|\/)templates\/|\.template\.tsx?$/u;
const GENERATED = /\/font-faces\.ts$/u;

function sourceFiles(): string[] {
  const files: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (['node_modules', 'dist', '.cache', '.wrangler', 'test'].includes(entry.name)) continue;
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (/\.tsx?$/u.test(entry.name) && !/\.(?:test|d)\.tsx?$/u.test(entry.name)) files.push(relative(root, path).split('\\').join('/'));
    }
  };
  walk(join(root, 'packages'));
  walk(join(root, 'apps'));
  return files.filter((file) => SOURCE_DIRS.some((pattern) => pattern.test(file)) && !GENERATED.test(file));
}

export function lintCopy(): CopyIssue[] {
  const issues = FIXED_TEXTS.flatMap((item) => item.paragraphs.flatMap((paragraph, index) => fixedTextIssues(`fixed text ${item.id}, paragraph ${index + 1}`, paragraph)));
  for (const file of sourceFiles()) {
    const source = readFileSync(join(root, file), 'utf8');
    issues.push(...proseLiteralIssues(file, source));
    if (TEMPLATE.test(file)) {
      const literals = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
      const visit = (node: ts.Node): void => {
        if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node) || ts.isTemplateHead(node) || ts.isTemplateMiddle(node) || ts.isTemplateTail(node)) {
          issues.push(...fixedTextIssues(`${file}:${literals.getLineAndCharacterOfPosition(node.getStart(literals)).line + 1}`, node.text).filter((issue) => !issue.rule.startsWith('Use typographic') || PROSE.test(node.text)));
        }
        ts.forEachChild(node, visit);
      };
      visit(literals);
    }
  }
  return issues;
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const issues = lintCopy();
  for (const issue of issues) process.stderr.write(`${issue.where}: ${issue.rule}\n    ${issue.excerpt}\n`);
  if (issues.length > 0) process.exitCode = 1;
  else process.stdout.write('Copy checked.\n');
}
