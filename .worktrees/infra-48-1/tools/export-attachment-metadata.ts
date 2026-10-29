import { readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { basename, dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import ts from 'typescript';

/**
 * Exports the current site's attachment metadata module to JSON for the journal import (design, "Import journal").
 *
 * The module is read statically with the TypeScript parser and never executed, so asset imports and site code do not need to resolve. Values that are
 * not plain data (calls, JSX, functions) are left out, and their key names are reported.
 */

export interface AttachmentMetadata {
  readonly title?: string;
  readonly kind?: string;
  readonly credit?: string;
  readonly creditLine?: string;
  readonly caption?: string;
  readonly sizeLabel?: string;
  readonly origin?: string;
  readonly sitePath: string;
  readonly fileName: string;
}

export interface MetadataExport {
  readonly entries: readonly AttachmentMetadata[];
  /** Keys of metadata entries that map to no exported field, by name only. */
  readonly unmappedKeys: readonly string[];
  /** Keys whose values are not plain data and were left out, by name only. */
  readonly unevaluatedKeys: readonly string[];
}

type Field = Exclude<keyof AttachmentMetadata, 'fileName'>;

/** Source key names for each field, in order of preference. */
export const FIELD_KEYS: Readonly<Record<Field, readonly string[]>> = {
  sitePath: ['sitePath', 'path', 'href', 'src', 'url', 'file', 'filePath', 'fileName', 'filename'],
  title: ['title', 'name', 'label', 'heading'],
  kind: ['kind', 'fileKind', 'type', 'fileType', 'format', 'category'],
  credit: ['credit', 'creditedTo', 'contributor', 'author', 'by'],
  creditLine: ['creditLine', 'credit_line', 'creditText', 'attribution'],
  caption: ['caption', 'description', 'summary', 'alt'],
  sizeLabel: ['sizeLabel', 'bytesLabel', 'size', 'fileSize', 'sizeText'],
  origin: ['origin', 'source', 'provenance'],
};

const UNKNOWN: unique symbol = Symbol('unknown');
type Value = string | number | boolean | null | readonly Value[] | DataObject | typeof UNKNOWN;
interface DataObject { readonly [key: string]: Value }

const FILE_LIKE = /[^/\s]\.[A-Za-z0-9]{1,8}$/u;
const isObject = (value: Value): value is DataObject => typeof value === 'object' && value !== null && !Array.isArray(value);

class Evaluator {
  readonly constants = new Map<string, ts.Expression>();
  readonly imports = new Map<string, string>();
  readonly unevaluated = new Set<string>();
  private readonly active = new Set<string>();

  constructor(file: ts.SourceFile) {
    for (const statement of file.statements) {
      if (ts.isImportDeclaration(statement) && ts.isStringLiteral(statement.moduleSpecifier)) {
        const name = statement.importClause?.name;
        if (name) this.imports.set(name.text, statement.moduleSpecifier.text);
      } else if (ts.isVariableStatement(statement)) {
        for (const declaration of statement.declarationList.declarations) {
          if (ts.isIdentifier(declaration.name) && declaration.initializer) this.constants.set(declaration.name.text, declaration.initializer);
        }
      }
    }
  }

  identifier(name: string): Value {
    const imported = this.imports.get(name);
    if (imported !== undefined) return imported;
    const expression = this.constants.get(name);
    if (!expression || this.active.has(name)) return UNKNOWN;
    this.active.add(name);
    try { return this.evaluate(expression); } finally { this.active.delete(name); }
  }

  evaluate(node: ts.Expression): Value {
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
    if (ts.isNumericLiteral(node)) return Number(node.text);
    if (node.kind === ts.SyntaxKind.TrueKeyword) return true;
    if (node.kind === ts.SyntaxKind.FalseKeyword) return false;
    if (node.kind === ts.SyntaxKind.NullKeyword) return null;
    if (ts.isParenthesizedExpression(node) || ts.isAsExpression(node) || ts.isSatisfiesExpression(node) || ts.isTypeAssertionExpression(node) || ts.isNonNullExpression(node)) {
      return this.evaluate(node.expression);
    }
    if (ts.isIdentifier(node)) return this.identifier(node.text);
    if (ts.isTemplateExpression(node)) {
      let text = node.head.text;
      for (const span of node.templateSpans) {
        const value = this.evaluate(span.expression);
        if (typeof value !== 'string' && typeof value !== 'number') return UNKNOWN;
        text += String(value) + span.literal.text;
      }
      return text;
    }
    if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken) {
      const left = this.evaluate(node.left);
      const right = this.evaluate(node.right);
      if ((typeof left === 'string' || typeof left === 'number') && (typeof right === 'string' || typeof right === 'number')) {
        return typeof left === 'number' && typeof right === 'number' ? left + right : String(left) + String(right);
      }
      return UNKNOWN;
    }
    if (ts.isNewExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'URL' && node.arguments?.[0]) {
      return this.evaluate(node.arguments[0]);
    }
    if (ts.isPropertyAccessExpression(node) && node.name.text === 'href' && ts.isNewExpression(node.expression)) return this.evaluate(node.expression);
    if (ts.isArrayLiteralExpression(node)) {
      const items: Value[] = [];
      for (const element of node.elements) {
        if (ts.isSpreadElement(element)) {
          const spread = this.evaluate(element.expression);
          if (Array.isArray(spread)) items.push(...(spread as readonly Value[]));
        } else {
          items.push(this.evaluate(element));
        }
      }
      return items;
    }
    if (ts.isObjectLiteralExpression(node)) {
      const result: Record<string, Value> = {};
      for (const property of node.properties) {
        if (ts.isSpreadAssignment(property)) {
          const spread = this.evaluate(property.expression);
          if (isObject(spread)) Object.assign(result, spread);
          continue;
        }
        const name = property.name && (ts.isIdentifier(property.name) || ts.isStringLiteral(property.name) || ts.isNumericLiteral(property.name)) ? property.name.text : undefined;
        if (name === undefined) continue;
        const value = ts.isPropertyAssignment(property) ? this.evaluate(property.initializer)
          : ts.isShorthandPropertyAssignment(property) ? this.identifier(property.name.text) : UNKNOWN;
        if (value === UNKNOWN) this.unevaluated.add(name);
        result[name] = value;
      }
      return result;
    }
    return UNKNOWN;
  }
}

function exportedExpressions(file: ts.SourceFile, evaluator: Evaluator): ts.Expression[] {
  const expressions: ts.Expression[] = [];
  const exported = (node: ts.Node): boolean => ts.canHaveModifiers(node) && !!ts.getModifiers(node)?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword);
  for (const statement of file.statements) {
    if (ts.isVariableStatement(statement) && exported(statement)) {
      for (const declaration of statement.declarationList.declarations) if (declaration.initializer) expressions.push(declaration.initializer);
    } else if (ts.isExportAssignment(statement)) {
      expressions.push(statement.expression);
    } else if (ts.isExportDeclaration(statement) && !statement.moduleSpecifier && statement.exportClause && ts.isNamedExports(statement.exportClause)) {
      for (const element of statement.exportClause.elements) {
        const local = evaluator.constants.get((element.propertyName ?? element.name).text);
        if (local) expressions.push(local);
      }
    }
  }
  return expressions;
}

const text = (value: Value | undefined): string | undefined => {
  if (typeof value === 'string') return value.trim() === '' ? undefined : value;
  if (typeof value === 'number') return String(value);
  if (value !== undefined && isObject(value)) return text(value['name'] ?? value['displayName'] ?? value['label']);
  return undefined;
};

function toEntry(object: DataObject, key: string | undefined, unmapped: Set<string>): AttachmentMetadata | undefined {
  const used = new Set<string>();
  const pick = (field: Field): string | undefined => {
    for (const name of FIELD_KEYS[field]) {
      if (used.has(name) || !(name in object)) continue;
      const value = text(object[name]);
      if (field === 'sitePath' && (value === undefined || !FILE_LIKE.test(value))) continue;
      used.add(name);
      return value;
    }
    return undefined;
  };
  const sitePath = pick('sitePath') ?? (key !== undefined && FILE_LIKE.test(key) ? key : undefined);
  if (sitePath === undefined) return undefined;
  const fields: Partial<Record<Field, string>> = { sitePath };
  for (const field of Object.keys(FIELD_KEYS) as Field[]) {
    if (field === 'sitePath') continue;
    const value = pick(field);
    if (value !== undefined) fields[field] = value;
  }
  for (const name of Object.keys(object)) if (!used.has(name)) unmapped.add(name);
  return { ...fields, sitePath, fileName: basename(sitePath.split(/[?#]/u)[0] ?? sitePath) };
}

/** Reads attachment metadata entries from the source text of the current site's metadata module. */
export function extractAttachmentMetadata(source: string, fileName = 'attachments.ts'): MetadataExport {
  const file = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, fileName.endsWith('x') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const evaluator = new Evaluator(file);
  const entries: AttachmentMetadata[] = [];
  const seen = new Set<DataObject>();
  const unmapped = new Set<string>();
  const walk = (value: Value, key?: string): void => {
    if (Array.isArray(value)) { (value as readonly Value[]).forEach((item) => walk(item)); return; }
    if (!isObject(value) || seen.has(value)) return;
    seen.add(value);
    const entry = toEntry(value, key, unmapped);
    if (entry) { entries.push(entry); return; }
    for (const [name, child] of Object.entries(value)) walk(child, name);
  };
  const exported = exportedExpressions(file, evaluator);
  for (const expression of exported) walk(evaluator.evaluate(expression));
  if (entries.length === 0) for (const expression of evaluator.constants.values()) walk(evaluator.evaluate(expression));
  const bySitePath = new Map<string, AttachmentMetadata>();
  for (const entry of entries) bySitePath.set(entry.sitePath, { ...entry, ...bySitePath.get(entry.sitePath) });
  return { entries: [...bySitePath.values()], unmappedKeys: [...unmapped].sort(), unevaluatedKeys: [...evaluator.unevaluated].sort() };
}

export const repositoryRoot = fileURLToPath(new URL('..', import.meta.url));

/** Whether a path lies inside the repository; the tools never write journal material there. */
export function insideRepository(path: string): boolean {
  let target = resolve(path);
  try { target = resolve(realpathSync(dirname(target)), basename(target)); } catch { /* the folder does not exist yet */ }
  const from = relative(realpathSync(repositoryRoot), target);
  return from === '' || (from !== '..' && !from.startsWith(`..${sep}`) && !isAbsolute(from));
}

function main(args: readonly string[]): number {
  const [modulePath, outputPath] = args;
  if (modulePath === undefined || outputPath === undefined) {
    process.stderr.write('Usage: npm run tools:export-metadata -- <metadata module .ts> <output .json outside the repository>\n');
    return 2;
  }
  if (insideRepository(outputPath)) {
    process.stderr.write('The output path is inside the repository. Write the metadata JSON outside it, next to the journal.\n');
    return 2;
  }
  const result = extractAttachmentMetadata(readFileSync(modulePath, 'utf8'), modulePath);
  if (result.entries.length === 0) {
    process.stderr.write('No attachment entries were found: no exported object has a file path in any of these keys: ' + FIELD_KEYS.sitePath.join(', ') + '\n');
    return 1;
  }
  writeFileSync(outputPath, `${JSON.stringify(result.entries, null, 2)}\n`);
  const missing = (Object.keys(FIELD_KEYS) as Field[]).map((field) => [field, result.entries.filter((entry) => entry[field] === undefined).length] as const).filter(([, count]) => count > 0);
  const lines = [
    `Attachment metadata entries written: ${result.entries.length}`,
    ...missing.map(([field, count]) => `Entries without ${field}: ${count}`),
    `Unmapped keys: ${result.unmappedKeys.length === 0 ? 'none' : result.unmappedKeys.join(', ')}`,
    `Keys with values that are not plain data: ${result.unevaluatedKeys.length === 0 ? 'none' : result.unevaluatedKeys.join(', ')}`,
  ];
  process.stdout.write(`${lines.join('\n')}\n`);
  return 0;
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) process.exitCode = main(process.argv.slice(2));
