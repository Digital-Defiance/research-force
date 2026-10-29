import { readFileSync, readdirSync } from 'node:fs';
import { dirname, isAbsolute, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

export const root = fileURLToPath(new URL('../', import.meta.url));
export const boundaries = {
  domain: [], kernel: ['domain'], markdown: ['domain'], manifest: ['domain'],
  design: ['domain'], 'public-render': ['domain', 'kernel', 'design', 'markdown'],
  'search-public': ['kernel', 'domain'], db: ['domain'],
  testing: ['domain', 'kernel', 'markdown', 'manifest', 'design', 'public-render', 'search-public', 'db'],
  app: ['domain', 'kernel', 'markdown', 'manifest', 'design', 'public-render', 'search-public', 'db', 'testing'],
  'site-shell': ['design', 'search-public'], submit: ['db', 'domain'],
  dl: ['db', 'domain'], ops: ['db', 'domain'],
  tools: ['domain', 'kernel', 'markdown', 'manifest', 'design', 'public-render', 'search-public', 'db', 'testing'],
};

function owner(path) {
  const match = relative(root, path).replaceAll('\\', '/').match(/^(?:packages|apps)\/([^/]+)\//);
  return match?.[1] ?? (relative(root, path).startsWith('tools/') ? 'tools' : undefined);
}

export function checkSource(filename, source) {
  const from = owner(filename);
  if (!from) return [];
  const allowed = boundaries[from];
  const testFile = /(?:\/test\/|\.test\.)/.test(filename);
  const errors = [];
  const ast = ts.createSourceFile(filename, source, ts.ScriptTarget.Latest, true);
  function inspect(node) {
    let specifier;
    let typeOnly = false;
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
      specifier = node.moduleSpecifier;
      typeOnly = ts.isImportDeclaration(node)
        ? !!node.importClause?.isTypeOnly || (!!node.importClause?.namedBindings && ts.isNamedImports(node.importClause.namedBindings) && !node.importClause.name && node.importClause.namedBindings.elements.length > 0 && node.importClause.namedBindings.elements.every((item) => item.isTypeOnly))
        : node.isTypeOnly || (!!node.exportClause && ts.isNamedExports(node.exportClause) && node.exportClause.elements.length > 0 && node.exportClause.elements.every((item) => item.isTypeOnly));
    } else if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument)) {
      specifier = node.argument.literal;
      typeOnly = true;
    } else if (ts.isCallExpression(node) && (node.expression.kind === ts.SyntaxKind.ImportKeyword || (ts.isIdentifier(node.expression) && node.expression.text === 'require'))) {
      specifier = node.arguments[0];
      if (!specifier || !ts.isStringLiteralLike(specifier)) errors.push('Computed module imports cannot be checked.');
    }
    if (specifier && ts.isStringLiteralLike(specifier)) {
      const name = specifier.text;
      const to = name.startsWith('@researchforce/') ? name.split('/')[1]
        : name.startsWith('.') || isAbsolute(name) ? owner(resolve(dirname(filename), name)) : undefined;
      if (!testFile && from === 'kernel' && !to) errors.push(`kernel may depend only on domain: ${name}`);
      if (to && to !== from && !allowed?.includes(to) && !(testFile && to === 'testing')) {
        errors.push(`${from} cannot import ${to}: ${name}`);
      }
      if (to === 'kernel' && ['public-render', 'search-public'].includes(from) && !typeOnly) {
        errors.push(`${from} may import only types from kernel: ${name}`);
      }
      if (name.startsWith('@researchforce/') && !to) errors.push(`Unknown workspace import: ${name}`);
    }
    ts.forEachChild(node, inspect);
  }
  inspect(ast);
  return errors;
}

function* sources(path) {
  for (const entry of readdirSync(path, { withFileTypes: true })) {
    if (['node_modules', 'dist', '.cache', '.wrangler', '.git'].includes(entry.name)) continue;
    const full = resolve(path, entry.name);
    if (entry.isDirectory()) yield* sources(full);
    else if (/\.[cm]?[jt]sx?$/.test(entry.name)) yield full;
  }
}

export function checkBoundaries() {
  const errors = [];
  for (const folder of ['packages', 'apps', 'tools']) {
    for (const filename of sources(resolve(root, folder))) {
      for (const error of checkSource(filename, readFileSync(filename, 'utf8'))) errors.push(`${relative(root, filename)}: ${error}`);
    }
  }
  // References must remain the direct dependency graph, not just a build-order list.
  for (const [name, allowed] of Object.entries(boundaries)) {
    const folder = name === 'tools' ? 'tools' : `${['app', 'site-shell', 'submit', 'dl', 'ops'].includes(name) ? 'apps' : 'packages'}/${name}`;
    const config = JSON.parse(readFileSync(resolve(root, folder, 'tsconfig.json'), 'utf8'));
    const refs = config.references.map((entry) => entry.path.split('/').at(-1)).sort();
    if (JSON.stringify(refs) !== JSON.stringify([...allowed].sort())) errors.push(`${folder}/tsconfig.json: references differ from the permitted dependencies`);
  }
  return errors;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const errors = checkBoundaries();
  if (errors.length) { console.error(errors.join('\n')); process.exitCode = 1; }
  else console.log('Workspace import boundaries checked.');
}
