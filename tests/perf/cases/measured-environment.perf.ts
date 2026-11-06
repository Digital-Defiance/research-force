/**
 * The runtime-MEASUREMENT certifications that require the real deployed/benchmark environment and
 * Reference_Archive (task 46.2; R28.1, R28.3, R28.6, R28.15, R30.6, R60.7).
 *
 * None of these can be a pure/derivable fact: they are the actual CPU, peak isolate memory, binding
 * calls, statements, rows, encoded bytes under load, D1 growth, and full transfer sizes MEASURED
 * against the worst-case inputs and the real corpus, plus the common-term 50 MB search latency with
 * large result pages, the 1,000-unit preview path, and the 100-file submission path. Every one is
 * reported BLOCKED (a non-pass) when its environment handles are absent — never a green skip and
 * never a fabricated measured number. The `measure` branch is only reached in the real environment,
 * so a build checkout enumerates them all as BLOCKED without any infrastructure.
 */
import { handle, measuredOrBlocked } from '../support/measurement';
import type { Certification, MeasuredDatum } from '../support/measurement';

/** The common environment handles every measured case needs: a benchmark endpoint and operator token. */
function benchmarkHandles() {
  return [
    handle('PERF_BENCHMARK_ENDPOINT', process.env['PERF_BENCHMARK_ENDPOINT']),
    handle('PERF_BENCHMARK_TOKEN', process.env['PERF_BENCHMARK_TOKEN']),
    handle('PERF_REFERENCE_ARCHIVE', process.env['PERF_REFERENCE_ARCHIVE']),
  ];
}

/** A required-measurement datum placeholder (value 0): the real value must come from the benchmark. */
function required(label: string, unit: MeasuredDatum['unit']): MeasuredDatum {
  return { label: `required measurement: ${label}`, value: 0, unit, kind: 'required_measurement' };
}

/** The never-fabricated reader: only invoked in the real environment; a checkout never reaches it. */
function neverHere(name: string): () => readonly MeasuredDatum[] {
  return () => {
    throw new Error(`"${name}" is measured only against the real deployed/benchmark environment; it is never fabricated in a build checkout.`);
  };
}

/** The runtime-measurement certifications, all BLOCKED-pending-environment in a build checkout. */
export function measuredEnvironmentCertifications(): readonly Certification[] {
  return [
    measuredOrBlocked(
      'worst-case CPU & peak concurrent-isolate memory on maximum inputs',
      ['R28.3', 'R28.15', 'R60.7'],
      benchmarkHandles(),
      [required('worst-case interactive CPU', 'ms'), required('peak concurrent isolate memory', 'MiB')],
      neverHere('worst-case CPU & memory'),
      'Measures real CPU and peak isolate memory (shared across concurrent requests) for the worst-case Unicode/spans/chunks and inline revision inputs.',
    ),
    measuredOrBlocked(
      'actual D1 binding calls, statements, rows & database growth per worst-case save',
      ['R28.2', 'R28.3', 'R28.15'],
      benchmarkHandles(),
      [required('actual binding calls per save', 'calls'), required('actual statements per save', 'statements'), required('actual rows read per save', 'count'), required('actual rows written per save', 'count'), required('D1 database growth', 'bytes')],
      neverHere('actual D1 usage & growth'),
      'Measures the real binding-call/statement/row usage and D1 database growth of a worst-case authorized save against the Reference_Archive, kept separate from the chosen statement guard.',
    ),
    measuredOrBlocked(
      'common-term 50 MB public search latency with large result pages',
      ['R30.6', 'R28.6', 'R60.7'],
      benchmarkHandles(),
      [required('p50 search page latency', 'ms'), required('p95 search page latency', 'ms'), required('p99 search page latency', 'ms'), required('full transfer size of a large result page', 'bytes')],
      neverHere('50 MB common-term search latency'),
      'Measures real common-term search and pagination latency (percentiles) and the full transfer size with the public indexed text at the 50 MB ceiling, on a connection of at least 10 Mbit/s (R30.6).',
    ),
    measuredOrBlocked(
      '1,000-unit preview working-memory & CPU path',
      ['R28.3', 'R28.15'],
      benchmarkHandles(),
      [required('preview peak working bytes', 'bytes'), required('preview CPU', 'ms')],
      neverHere('1,000-unit preview path'),
      'Measures the real 1,000-row/unit preview path against the chosen preview working-memory budget (CSV scan/record/buffer and raster/pdf caches).',
    ),
    measuredOrBlocked(
      '100-file submission transfer size, statements & rows',
      ['R28.3', 'R28.8', 'R28.15'],
      benchmarkHandles(),
      [required('100-file submission full transfer size', 'bytes'), required('100-file submission statements', 'statements'), required('100-file submission rows written', 'count')],
      neverHere('100-file submission path'),
      'Measures the real transfer size, statements, and rows of a 100-file submission and its draft/proposal graph save.',
    ),
    measuredOrBlocked(
      'publisher epoch/removal full transfer & timing',
      ['R28.8', 'R60.7'],
      benchmarkHandles(),
      [required('publisher epoch full transfer size', 'bytes'), required('removal propagation time', 'ms')],
      neverHere('publisher epoch/removal'),
      'Measures the real full transfer size and timing of a publisher epoch and an urgent removal against the Reference_Archive.',
    ),
  ];
}
