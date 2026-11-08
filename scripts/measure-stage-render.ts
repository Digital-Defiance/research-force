import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { assertPublicCopy } from '@researchforce/design/installation';
import { decodeShellBundle } from '../packages/public-render/src/shell-bundle';
import { renderPlanned } from '../apps/app/src/publisher/render';
import type { ShellAsset } from '../apps/app/src/publisher/render';
import type { Timestamp } from '../packages/domain/src/types';

// Measures what ONE Publisher stage invocation costs on the Workers Free plan's CPU and memory axes: the REAL site
// loader (`loadSiteInput`, parsing every stored view JSON), the REAL renderer (`renderSite` + search index + headers),
// the real staged shell bundle, and Direct Upload hashing of every produced file, i.e. exactly `renderPlanned`. D1 is
// an in-memory stand-in that returns the stored rows (its I/O is not CPU time on the platform); each size runs in a
// fresh process so the heap numbers are not polluted by an earlier size. The Free-plan ceiling
// (`FREE_PLAN_SITE_VIEW_CEILING`, packages/domain/src/slice-budget.ts) is set from this script's output.
//
//   npm run build   # stages apps/app/web/dist/_shell/bundle.bin, the real shell assets
//   node --expose-gc --import tsx scripts/measure-stage-render.ts [sizes...]
//
// Node runs the same V8 engine as workerd, so the order of magnitude carries over; it is not the platform's meter.

const DEFAULT_SIZES = [250, 500, 1_000, 2_000, 4_000];
const self = fileURLToPath(import.meta.url);

async function measureOne(items: number): Promise<void> {
  const rows = viewRows(items);
  const bundlePath = fileURLToPath(new URL('../apps/app/web/dist/_shell/bundle.bin', import.meta.url));
  const shellAssets: ShellAsset[] = existsSync(bundlePath) ? decodeShellBundle(new Uint8Array(readFileSync(bundlePath))) : [];
  const deps = {
    core: fakeD1([]), public: fakeD1(rows), licence: { name: 'Synthetic Licence', url: 'https://licence.example.test/' },
    publicCopy: assertPublicCopy(SYNTHETIC_COPY), shellAssets,
  };
  const gc = (globalThis as { gc?: () => void }).gc;
  gc?.();
  const base = process.memoryUsage().heapUsed;
  let peak = base;
  const sampler = setInterval(() => { peak = Math.max(peak, process.memoryUsage().heapUsed); }, 1);
  const cpuBefore = process.cpuUsage();
  const result = await renderPlanned(deps as never, new Date().toISOString() as Timestamp);
  const cpu = process.cpuUsage(cpuBefore);
  clearInterval(sampler);
  peak = Math.max(peak, process.memoryUsage().heapUsed);
  const arrayBuffers = process.memoryUsage().arrayBuffers;
  let output = 0;
  for (const { file } of result.files.values()) output += file.content.length;
  const mb = (n: number) => (n / 1e6).toFixed(1);
  console.log([items, rows.length, result.files.size, Math.round((cpu.user + cpu.system) / 1000), mb(peak - base), mb(arrayBuffers), mb(output)].join('\t'));
}

/** The stored current-view rows of one Project with `items` cross-linked Research_Items (each links to both neighbours). */
function viewRows(items: number): { unitKey: string; viewJson: string }[] {
  const project = { key: 'p:1', name: 'Synthetic Project', slug: 'synthetic', path: '/p/synthetic' };
  const status = { kind: 'hypothesis', status: { id: '00000000000000000000000002', name: 'Eliminated' } };
  const relation = { id: '01V00000000000000000000008', name: 'Related' };
  const id = (index: number) => `S${String(index).padStart(5, '0')}-0000-0000`;
  const link = (index: number) => ({ tag: 'link', key: `u:s${index}`, path: `/r/${id(index)}`, type: 'research_item', title: `Synthetic item ${index}`, kind: 'hypothesis', status });
  const rows = [{ unitKey: project.key, viewJson: JSON.stringify({ tag: 'project', ...project, description: 'A synthetic project.' }) }];
  for (let index = 0; index < items; index++) {
    rows.push({ unitKey: `u:s${index}`, viewJson: JSON.stringify({
      tag: 'research_item', key: `u:s${index}`, path: `/r/${id(index)}`, kind: 'hypothesis', title: `Synthetic item ${index}`,
      publicSummary: { text: `A synthetic public summary of item ${index}, a few sentences long so the page carries body text.`, spans: [] },
      itemDate: { value: '1952', approx: false }, logDate: { value: '1953-01-01', approx: false }, credit: [{ name: 'Carla Imported' }],
      identifier: id(index), status, project, firstPublicOn: '2026-01-06', attachments: [],
      links: [
        { direction: 'outgoing', relation, target: link((index + 1) % items) },
        { direction: 'incoming', relation, target: link((index + items - 1) % items) },
      ],
    }) });
  }
  return rows;
}

/** A D1 stand-in: `public_views` reads return the given rows, every other read is empty, writes do nothing. */
function fakeD1(views: readonly { unitKey: string; viewJson: string }[]) {
  const answer = (query: string) => ({ results: query.includes('FROM public_views') ? [...views] : [], success: true, meta: {} });
  const statement = (query: string) => {
    const stmt = { bind: () => stmt, all: async () => answer(query), first: async () => null, run: async () => answer(query), query };
    return stmt;
  };
  return { prepare: statement, batch: async (statements: { query: string }[]) => statements.map((s) => answer(s.query)) };
}

const SYNTHETIC_COPY = {
  version: '2026-02-02', name: 'Synthetic Collective', strapline: 'A synthetic strapline',
  mission: { heading: 'Our mission', paragraphs: ['A synthetic mission paragraph for the measurement.'] },
  about: ['A synthetic about paragraph.'],
  principles: [{ name: 'Synthetic principle', text: 'A synthetic principle text.' }],
};

if (process.argv[2] !== '--one') {
  const sizes = process.argv.slice(2).map(Number).filter((n) => n > 0);
  console.log('items\tviews\tfiles\tcpu_ms\tpeak_heap_mb\tarray_buffers_mb\toutput_mb\tmin_old_space_mb');
  for (const size of sizes.length > 0 ? sizes : DEFAULT_SIZES) {
    const run = (limitMb?: number) => spawnSync(process.execPath, [
      '--expose-gc', ...(limitMb === undefined ? [] : [`--max-old-space-size=${limitMb}`]), '--import', 'tsx', self, '--one', String(size),
    ], { encoding: 'utf8' });
    const free = run();
    if (free.status !== 0) { console.error(free.stderr); process.exit(1); }
    // The smallest V8 old-space limit (8 MB steps) the stage render completes under: the peak live heap it needs,
    // which the sampled peak below can miss while the synchronous render holds the thread.
    let low = 8;
    let high = 512;
    while (high - low > 8) {
      const mid = Math.round((low + high) / 16) * 8;
      if (run(mid).status === 0) high = mid; else low = mid;
    }
    console.log(`${free.stdout.trim()}\t${high}`);
  }
} else {
  await measureOne(Number(process.argv[3]));
}
