import { z } from 'zod';

const taskId = z.string().regex(/^\d+\.\d+$/u);
const gateSchema = z.strictObject({
  id: z.string().min(1), checkerTask: taskId.optional(), evidenceTask: taskId.optional(),
  requiredTasks: z.array(taskId).optional(), requiresGates: z.array(z.string()).optional(),
  requiredEvidence: z.array(z.string().min(1)).min(1), beforeTasks: z.array(taskId).optional(),
  beforeEnable: z.array(z.string().min(1)).optional(),
});
export const graphSchema = z.strictObject({
  schemaVersion: z.literal(2), semantics: z.record(z.string(), z.string()),
  completedBaseline: z.array(taskId),
  phases: z.record(z.string(), z.strictObject({ firstWave: z.number().int().nonnegative(), lastWave: z.number().int().nonnegative() })),
  waves: z.array(z.strictObject({ id: z.number().int().nonnegative(), phase: z.string(), dependsOn: z.array(z.number().int().nonnegative()), tasks: z.array(taskId).min(1) })),
  helperEdges: z.array(z.tuple([taskId, taskId])), gates: z.array(gateSchema).min(1),
});
const pathSchema = z.string().min(1);
const evidenceRecordSchema = z.strictObject({
  task: taskId, state: z.enum(['accepted', 'reopened', 'partial']), reason: z.string().min(1),
  sourcePaths: z.array(pathSchema), testPaths: z.array(pathSchema),
  correctionTasks: z.array(taskId).default([]), checks: z.array(pathSchema).default([]),
});
export const evidenceSchema = z.strictObject({
  schemaVersion: z.literal(1), historicalBaseline: z.array(taskId),
  historicalPolicy: z.string().min(1), records: z.array(evidenceRecordSchema),
});
export const testReportSchema = z.strictObject({
  schemaVersion: z.literal(1), command: z.string().min(1), recordedAt: z.iso.datetime(),
  scope: z.literal('local-synthetic'), success: z.literal(true),
  suites: z.array(z.strictObject({ path: pathSchema, passed: z.number().int().nonnegative(), failed: z.literal(0), skipped: z.literal(0) })).min(1),
  files: z.record(pathSchema, z.string().regex(/^[a-f0-9]{64}$/u)),
});
export type Evidence = z.infer<typeof evidenceSchema>;
export type Graph = z.infer<typeof graphSchema>;
export interface PathInfo { readonly kind: 'file' | 'directory' | 'missing'; readonly sha256?: string }
export interface SpecInput {
  readonly requirements: string; readonly design: string; readonly tasks: string; readonly evidence: unknown;
  readonly propertyFiles: readonly string[];
  readonly inspect: (path: string) => PathInfo;
  readonly readReport: (path: string) => unknown;
}
interface Requirement { id: number; title: string; criteria: string[] }
interface Property { id: number; title: string; requirements: string[] }
interface Task { id: string; title: string; checked: boolean; body: string; requirements: string[]; properties: number[]; paths: string[] }

/** Repository-relative paths only; reports never follow a spec reference outside the checkout. */
export function safePath(path: string): boolean {
  return path.length > 0 && !path.startsWith('/') && !path.includes('\\') && !path.includes('\0')
    && path.split('/').every((part) => part !== '..' && part !== '.');
}
const refs = (value: string): string[] => [...new Set(value.match(/(?<!\d)\d+\.\d+(?!\d)/gu) ?? [])];
const equalSet = <T>(a: readonly T[], b: readonly T[]): boolean => a.length === b.length && a.every((v) => b.includes(v));
const duplicates = <T>(values: readonly T[]): T[] => [...new Set(values.filter((v, i) => values.indexOf(v) !== i))];
const declarations = (body: string): string[] => [...body.matchAll(/(?:_Requirements:|\*\*Validates: Requirements)([^\n]+)/gu)].flatMap((m) => refs(m[1]!));

/** Structural traceability and dated local evidence, never a public-launch certificate. */
export function auditSpecs(input: SpecInput) {
  const issues: string[] = [];
  const issue = (message: string): void => { issues.push(message); };
  const inspect = (path: string): PathInfo => {
    if (!safePath(path)) { issue(`Unsafe repository path: ${path}`); return { kind: 'missing' }; }
    return input.inspect(path);
  };
  const requirements: Requirement[] = [];
  for (const m of input.requirements.matchAll(/^### Requirement (\d+): (.+)\n([\s\S]*?)(?=^### Requirement |^## Decisions|$(?![\s\S]))/gmu)) {
    const id = Number(m[1]);
    const numbers = [...m[3]!.matchAll(/^(\d+)\. /gmu)].map((v) => Number(v[1]));
    if (!numbers.length || numbers.some((n, i) => n !== i + 1)) issue(`Requirement ${id} has missing, duplicate or unordered criteria.`);
    requirements.push({ id, title: m[2]!, criteria: numbers.map((n) => `${id}.${n}`) });
  }
  if (!requirements.length || requirements.some((r, i) => r.id !== i + 1)) issue('Requirement headings must be sequential and unique.');
  const criteria = new Set(requirements.flatMap((r) => r.criteria));
  const properties: Property[] = [];
  for (const m of input.design.matchAll(/^### Property (\d+): (.+)\n([\s\S]*?)(?=^### Property |^## |$(?![\s\S]))/gmu)) {
    const validated = /\*\*Validates: Requirements ([^\n]+)\*\*/u.exec(m[3]!);
    if (!validated) issue(`Property ${m[1]} has no validation references.`);
    properties.push({ id: Number(m[1]), title: m[2]!, requirements: refs(validated?.[1] ?? '') });
  }
  if (!properties.length || properties.some((p, i) => p.id !== i + 1)) issue('Property headings must be sequential and unique.');
  for (const property of properties) for (const ref of property.requirements) if (!criteria.has(ref)) issue(`Property ${property.id} references unknown criterion ${ref}.`);

  const taskText = input.tasks.split('## Task Dependency Graph')[0]!;
  const headings = [...taskText.matchAll(/^(  )?- \[([ x])\] (\d+(?:\.\d+)?)\.? (.+)$/gmu)];
  const tasks: Task[] = [];
  const parents = new Map<string, { checked: boolean; title: string }>();
  for (let i = 0; i < headings.length; i += 1) {
    const m = headings[i]!;
    const id = m[3]!;
    if (!m[1]) { if (parents.has(id)) issue(`Duplicate parent task ${id}.`); parents.set(id, { checked: m[2] === 'x', title: m[4]! }); continue; }
    const body = taskText.slice(m.index!, headings[i + 1]?.index ?? taskText.length);
    const paths = [...body.matchAll(/`((?:apps|packages|tools|tests|infra|scripts|docs)\/[^`\n]+|README\.md|package\.json)`/gu)]
      .map((v) => v[1]!).filter((v) => !v.includes(' ') && !v.includes('*'));
    tasks.push({ id, title: m[4]!, checked: m[2] === 'x', body,
      requirements: [...new Set(declarations(body))],
      properties: [...body.matchAll(/\*\*Property (\d+):/gu)].map((v) => Number(v[1])), paths: [...new Set(paths)] });
    if (!/(?:_Requirements:|\*\*Validates: Requirements)/u.test(body)) issue(`Task ${id} has no explicit requirement declaration.`);
  }
  if (!tasks.length) issue('No leaf tasks found.');
  const ids = tasks.map((t) => t.id);
  for (const id of duplicates(ids)) issue(`Duplicate leaf task ${id}.`);
  const byTask = new Map(tasks.map((t) => [t.id, t]));
  for (const task of tasks) {
    const parent = parents.get(task.id.split('.')[0]!);
    if (!parent) issue(`Task ${task.id} has no parent.`);
    if (parent?.checked && !task.checked) issue(`Checked parent contains unfinished task ${task.id}.`);
    for (const ref of task.requirements) if (!criteria.has(ref)) issue(`Task ${task.id} references unknown criterion ${ref}.`);
    for (const number of task.properties) if (!properties.some((p) => p.id === number)) issue(`Task ${task.id} owns unknown property ${number}.`);
    for (const path of task.paths) inspect(path);
  }
  for (const criterion of criteria) if (!tasks.some((t) => t.requirements.includes(criterion))) issue(`Criterion ${criterion} has no task coverage.`);
  for (const property of properties) {
    const owners = tasks.filter((t) => t.properties.includes(property.id));
    if (owners.length !== 1) issue(`Property ${property.id} must have exactly one owning task; found ${owners.length}.`);
    if (owners[0] && (!equalSet(owners[0].requirements, property.requirements) || owners[0].properties.length !== 1)) issue(`Property ${property.id} and task ${owners[0].id} have different validation references.`);
  }
  if (/\[[ x]\]\*/u.test(taskText)) issue('Optional test checkbox markers are forbidden.');

  let graph: Graph | undefined;
  try {
    const json = /## Task Dependency Graph[\s\S]*?```json\n([\s\S]*?)\n```/u.exec(input.tasks)?.[1];
    graph = graphSchema.parse(JSON.parse(json ?? 'null'));
  } catch { issue('Task dependency graph is missing or invalid schema version 2 JSON.'); }
  const prerequisites = new Map<string, string[]>();
  if (graph) {
    const all = [...graph.completedBaseline, ...graph.waves.flatMap((w) => w.tasks)];
    for (const id of duplicates(all)) issue(`Graph schedules task ${id} more than once.`);
    for (const id of all) if (!byTask.has(id)) issue(`Graph references unknown task ${id}.`);
    for (const id of ids) if (!all.includes(id)) issue(`Graph omits task ${id}.`);
    if (!equalSet(graph.completedBaseline, tasks.filter((t) => t.checked).map((t) => t.id))) issue('Graph completed baseline must match checked leaf tasks exactly.');
    const positions = new Map(graph.completedBaseline.map((id) => [id, -1]));
    const waveIds = graph.waves.map((w) => w.id);
    for (const [i, wave] of graph.waves.entries()) {
      if (wave.id !== i) issue(`Wave IDs must be sequential; found ${wave.id} at ${i}.`);
      if (!equalSet(wave.dependsOn, i === 0 ? [] : [i - 1])) issue(`Wave ${wave.id} must depend on the preceding serial barrier.`);
      for (const predecessor of wave.dependsOn) if (!waveIds.includes(predecessor) || predecessor >= wave.id) issue(`Wave ${wave.id} has an unknown or cyclic predecessor ${predecessor}.`);
      if (!Object.hasOwn(graph.phases, wave.phase)) issue(`Wave ${wave.id} names unknown phase ${wave.phase}.`);
      for (const id of wave.tasks) {
        positions.set(id, wave.id);
        prerequisites.set(id, wave.dependsOn.flatMap((n) => graph!.waves.find((w) => w.id === n)?.tasks ?? []));
      }
    }
    for (const [name, range] of Object.entries(graph.phases)) {
      const actual = graph.waves.filter((w) => w.phase === name).map((w) => w.id);
      if (!actual.length || actual[0] !== range.firstWave || actual.at(-1) !== range.lastWave || actual.some((n, i) => n !== range.firstWave + i)) issue(`Phase ${name} has stale or noncontiguous wave bounds.`);
    }
    const narrativePhases = /^Canonical phases: (.+)$/mu.exec(input.tasks)?.[1]?.match(/`([^`]+)`/gu)?.map((v) => v.slice(1, -1)) ?? [];
    if (JSON.stringify(narrativePhases) !== JSON.stringify(Object.keys(graph.phases))) issue('Milestone canonical phase order differs from the graph.');
    for (const [before, after] of graph.helperEdges) {
      const a = positions.get(before); const b = positions.get(after);
      if (before === after || a === undefined || b === undefined || (b >= 0 && a >= b)) issue(`Invalid helper prerequisite ${before} -> ${after}.`);
      prerequisites.set(after, [...new Set([...(prerequisites.get(after) ?? []), before])]);
    }
    for (const id of duplicates(graph.gates.map((g) => g.id))) issue(`Duplicate gate ${id}.`);
    const gates = new Map(graph.gates.map((g) => [g.id, g]));
    const visiting = new Set<string>(); const visited = new Set<string>();
    const visit = (id: string): void => {
      if (visiting.has(id)) { issue(`Release gate cycle at ${id}.`); return; }
      if (visited.has(id)) return;
      visiting.add(id);
      for (const dep of gates.get(id)?.requiresGates ?? []) {
        if (!gates.has(dep)) issue(`Gate ${id} references unknown gate ${dep}.`); else visit(dep);
      }
      visiting.delete(id); visited.add(id);
    };
    for (const gate of graph.gates) {
      visit(gate.id);
      const dependencies = [gate.checkerTask, gate.evidenceTask, ...(gate.requiredTasks ?? []), ...(gate.beforeTasks ?? [])].filter((id): id is string => id !== undefined);
      for (const id of dependencies) if (!byTask.has(id)) issue(`Gate ${gate.id} references unknown task ${id}.`);
      if (!gate.checkerTask && !gate.requiresGates?.length) issue(`Gate ${gate.id} has no checker or prerequisite gate.`);
      for (const id of gate.beforeTasks ?? []) {
        const target = positions.get(id);
        for (const prior of [gate.checkerTask, gate.evidenceTask, ...(gate.requiredTasks ?? [])]) {
          if (prior && target !== undefined && target >= 0 && (positions.get(prior) ?? Infinity) >= target) issue(`Gate ${gate.id} requires ${prior} too late for ${id}.`);
        }
      }
    }
  }

  for (const path of input.propertyFiles) if (!safePath(path)) issue(`Unsafe property test path: ${path}`);
  const structuralIssues = [...issues];
  const parsedEvidence = evidenceSchema.safeParse(input.evidence);
  const records = parsedEvidence.success ? parsedEvidence.data.records : [];
  const historical = parsedEvidence.success ? parsedEvidence.data.historicalBaseline : [];
  if (!parsedEvidence.success) issue('Acceptance ledger is invalid schema version 1 JSON.');
  for (const id of duplicates(historical)) issue(`Duplicate historical baseline task ${id}.`);
  for (const id of historical) if (!byTask.has(id)) issue(`Historical baseline names unknown task ${id}.`);
  for (const id of duplicates(records.map((r) => r.task))) issue(`Duplicate acceptance record for task ${id}.`);
  for (const record of records) {
    const task = byTask.get(record.task);
    if (!task) issue(`Acceptance record names unknown task ${record.task}.`);
    for (const id of record.correctionTasks) if (!byTask.has(id)) issue(`Task ${record.task} names unknown correction task ${id}.`);
    if (record.state === 'accepted' && !task?.checked) issue(`Accepted task ${record.task} must be checked.`);
    if (record.state !== 'accepted' && task?.checked) issue(`Incomplete evidence for checked task ${record.task}.`);
    if (record.state === 'reopened' && !record.correctionTasks.length) issue(`Reopened task ${record.task} needs a correction task.`);
    const paths = [...record.sourcePaths, ...record.testPaths];
    for (const path of paths) if (inspect(path).kind !== 'file') issue(`Task ${record.task} evidence file is missing: ${path}`);
    if (record.state !== 'accepted') continue;
    if (!record.sourcePaths.length || !record.testPaths.length || !record.checks.length) issue(`Accepted task ${record.task} needs source, test and executed-check evidence.`);
    const reports: z.infer<typeof testReportSchema>[] = [];
    for (const path of record.checks) {
      if (!safePath(path)) { issue(`Unsafe evidence report path: ${path}`); continue; }
      try {
        const report = testReportSchema.parse(input.readReport(path));
        reports.push(report);
        if (new Set(report.suites.map((s) => s.path)).size !== report.suites.length || report.suites.some((s) => !safePath(s.path) || s.passed < 1)) issue(`Invalid passing suite inventory: ${path}`);
      } catch { issue(`Missing or invalid executed-check report: ${path}`); }
    }
    for (const path of paths) {
      const hash = inspect(path).sha256;
      if (!hash || !reports.some((report) => report.files[path] === hash)) issue(`Task ${record.task} evidence is stale or unfingerprinted: ${path}`);
    }
    for (const path of record.testPaths) if (!reports.some((report) => report.suites.some((suite) => suite.path === path))) issue(`Task ${record.task} has no passing executed suite for ${path}.`);
  }
  for (const task of tasks) if (task.checked && !historical.includes(task.id) && !records.some((r) => r.task === task.id && r.state === 'accepted')) issue(`Newly checked task ${task.id} has no acceptance record.`);
  const propertyFiles = (id: number): string[] => input.propertyFiles.filter((path) => Number(/\/p(\d+)-/u.exec(path)?.[1]) === id);

  return {
    schemaVersion: 1,
    nextTasks: graph?.waves[0]?.tasks ?? [],
    remainingBuildOrder: graph?.waves.flatMap((wave) => wave.tasks) ?? [],
    summary: { requirements: requirements.length, criteria: criteria.size, properties: properties.length,
      leafTasks: tasks.length, checkedLeaves: tasks.filter((t) => t.checked).length,
      historicalUnverified: tasks.filter((t) => t.checked && !records.some((r) => r.task === t.id && r.state === 'accepted')).length,
      acceptedWithLocalEvidence: records.filter((r) => r.state === 'accepted').length,
      propertyFiles: input.propertyFiles.length, remainingWaves: graph?.waves.length ?? 0, gates: graph?.gates.length ?? 0 },
    structuralIssues, issues,
    requirements: requirements.map((r) => ({ ...r, criteria: r.criteria.map((id) => ({ id, tasks: tasks.filter((t) => t.requirements.includes(id)).map((t) => t.id), properties: properties.filter((p) => p.requirements.includes(id)).map((p) => p.id) })) })),
    properties: properties.map((p) => ({ ...p, task: tasks.find((t) => t.properties.includes(p.id))?.id ?? null, testPaths: propertyFiles(p.id) })),
    tasks: tasks.map(({ body: _body, paths, ...task }) => {
      const evidence = records.find((r) => r.task === task.id) ?? null;
      return { ...task, prerequisites: prerequisites.get(task.id) ?? [],
        phase: graph?.waves.find((w) => w.tasks.includes(task.id))?.phase ?? 'completed_baseline',
        sourcePaths: [...new Set([...paths, ...(evidence?.sourcePaths ?? []), ...(evidence?.testPaths ?? []), ...task.properties.flatMap(propertyFiles)])].map((path) => ({ path, ...inspect(path) })),
        gates: graph?.gates.filter((g) => g.requiredTasks?.includes(task.id) || g.checkerTask === task.id || g.evidenceTask === task.id).map((g) => g.id) ?? [],
        acceptance: evidence?.state ?? (task.checked ? 'historical_unverified' : 'planned'), evidence };
    }),
    checkpoints: [...parents].filter(([id]) => !tasks.some((t) => t.id.startsWith(`${id}.`))).map(([id, p]) => ({ id, ...p })),
    knownGaps: records.filter((r) => r.state !== 'accepted'),
    phases: graph?.phases ?? {},
    gates: graph?.gates.map((gate) => ({ ...gate, certification: 'Not evaluated by the structural spec checker; task 68.4 owns runtime release acceptance.' })) ?? [],
  };
}
