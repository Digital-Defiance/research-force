import { getTableColumns, getTableName, sql } from 'drizzle-orm';
import type { SQL, SQLWrapper } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/d1';
import type { DrizzleD1Database } from 'drizzle-orm/d1';
import { SQLiteAsyncDialect } from 'drizzle-orm/sqlite-core';
import type { SQLiteTable } from 'drizzle-orm/sqlite-core';
import { newULID } from '@researchforce/domain/identifiers';
import { OPERATIONS } from '@researchforce/domain/settings';
import type { RevisionKind, Timestamp, ULID } from '@researchforce/domain/types';
import type { OutboxTopic, RequestAccountant } from './accountant';
import { outbox, revisions } from './schema/core';
import type { AiProvenance, REVISION_TARGET_TYPES } from './schema/core';

export const GUARD_CODES = [
  'rev', 'evidence', 'superseding', 'last_admin', 'chain_tip', 'decision_open', 'preview_fresh', 'log_summary_owner', 'dissent_unique', 'frozen',
  'upload_ready', 'upload_limit', 'reply_parent', 'review_eligible', 'reviewer_eligible', 'review_open', 'access_owner',
] as const;
export type GuardCode = typeof GUARD_CODES[number];
/** HTTP status and the rule each guard enforces, for the API's refusal (design "Guards"). */
export const GUARD_RULES: Readonly<Record<GuardCode, { readonly status: 409 | 422 | 503; readonly rule: string }>> = Object.freeze({
  upload_ready: { status: 422, rule: 'The uploaded file is incomplete, already used, or expired. Retry or remove it.' },
  upload_limit: { status: 422, rule: 'A Submission can contain at most 100 files.' },
  rev: { status: 409, rule: 'Another save changed this record after you opened it.' },
  evidence: { status: 422, rule: 'This status needs an Evidence_Link (R5.3, R8.2).' },
  superseding: { status: 422, rule: 'A Superseded Finding needs a link to the Finding that supersedes it (R5.4, R5.9).' },
  last_admin: { status: 422, rule: 'At least one active Administrator must remain (R2.11).' },
  chain_tip: { status: 409, rule: 'This Attachment already has a newer version (R13.7).' },
  decision_open: { status: 409, rule: 'This Outside_Submission already has a final Moderation_Decision (R32.16).' },
  preview_fresh: { status: 409, rule: 'The public view changed after the preview; preview the change again (R23.14).' },
  log_summary_owner: { status: 422, rule: 'Only the Owner of a Research_Item can change its Log_Summary (R41.4).' },
  dissent_unique: { status: 422, rule: 'A Member can have one current Dissent_Note per Log_Summary and cannot dissent from their own (R42.2).' },
  frozen: { status: 503, rule: 'Saving is paused for a backup (about a minute); your input is kept (R28.10).' },
  reply_parent: { status: 422, rule: 'The Item or Reply you are replying to no longer exists (R16.2, R16.3).' },
  review_eligible: { status: 422, rule: 'The addressees include no active Member other than you (R17.9).' },
  reviewer_eligible: { status: 422, rule: 'You are no longer an Eligible_Reviewer of this Review_Request (R17.10).' },
  review_open: { status: 422, rule: 'This Review_Request is already Reviewed (R17.3, R17.10).' },
  access_owner: { status: 422, rule: 'Only the Owner of a Research_Item can widen who reads it (R47.7).' },
});

/** The change sequence after the batch's second statement has incremented it. */
export const CHANGE_SEQ: SQL = sql`(SELECT v FROM counters WHERE k = 'change')`;
const INCREMENT_CHANGE = "UPDATE counters SET v = v + 1 WHERE k = 'change'";
const FROZEN_GUARD = "INSERT INTO _g_frozen (x) SELECT NULL WHERE NOT ((SELECT v FROM counters WHERE k = 'frozen') = 0)";
/** Strings above about 2 MB are refused by D1, so each json_each parameter stays well below that. */
const BULK_JSON_LIMIT = 1_000_000;

export class GuardViolation extends Error {
  readonly status: 409 | 422 | 503;
  constructor(readonly code: GuardCode, options?: ErrorOptions) {
    super(GUARD_RULES[code].rule, options);
    this.name = 'GuardViolation';
    this.status = GUARD_RULES[code].status;
  }
}

export class BatchTooLarge extends Error {
  constructor(readonly statements: number) {
    super(`A write batch may hold at most ${OPERATIONS.maxD1Statements} statements; this one has ${statements}.`);
    this.name = 'BatchTooLarge';
  }
}

/** The guard whose NOT NULL violation aborted a batch, if any. */
export function guardCodeOf(error: unknown): GuardCode | undefined {
  for (let current: unknown = error; current instanceof Error; current = current.cause) {
    const match = /NOT NULL constraint failed: _g_([a-z_]+)\.x/.exec(current.message);
    if (match && (GUARD_CODES as readonly string[]).includes(match[1]!)) return match[1] as GuardCode;
  }
  return undefined;
}

export interface BatchActor {
  /** The acting Member from the session, or null for scheduled work. Request bodies never supply it. */
  readonly id: ULID | null;
  readonly now: Timestamp;
}
export interface RevisionInput {
  readonly targetType: typeof REVISION_TARGET_TYPES[number];
  readonly targetId: string;
  readonly rootId?: string | null;
  readonly kind: RevisionKind;
  readonly reason?: string | null;
  readonly prev: unknown;
  readonly restoredPoint?: string | null;
  readonly ai?: AiProvenance | null;
}
type Stamp = 'updatedSeq' | 'actorId' | 'rev';
type Writable<T extends SQLiteTable> = Omit<T['$inferInsert'], Stamp>;

/**
 * Collects one save as a single D1 batch, which D1 runs as one transaction (design "Atomic writes").
 * The batch always starts with the `frozen` guard and the change-counter increment; every other
 * statement keeps the order in which it was added, so a guard can check the state after the writes
 * before it (for example the last-Administrator guard after a Role change).
 */
export class GuardedBatch {
  readonly #db: D1Database;
  readonly #orm: DrizzleD1Database;
  readonly #dialect = new SQLiteAsyncDialect();
  readonly #statements: { readonly sql: string; readonly params: readonly unknown[] }[] = [];
  readonly #topics = new Set<OutboxTopic>();
  readonly #deferred = new Map<string, (batch: GuardedBatch) => void>();

  constructor(db: D1Database, readonly actor: BatchActor, readonly options: { readonly ignoreFreeze?: boolean } = {}) {
    this.#db = db;
    this.#orm = drizzle(db);
  }

  /** Statements the batch will send, including the leading guard and counter increment. */
  get size(): number { return this.#statements.length + (this.options.ignoreFreeze ? 1 : 2); }
  /** Topics this batch writes outbox rows to, whose owners are kicked once it commits. */
  get outboxTopics(): readonly OutboxTopic[] { return [...this.#topics]; }

  /** Abort the whole batch unless `condition` holds when this statement runs; a NULL condition aborts too. */
  guard(code: GuardCode, condition: SQL): this {
    return this.#push(sql`INSERT INTO ${sql.identifier(`_g_${code}`)} (x) SELECT NULL WHERE (${condition}) IS NOT TRUE`);
  }

  /** Any other statement: a Drizzle query or a `sql` template. */
  run(query: SQL | SQLWrapper): this {
    if ('toSQL' in query && typeof query.toSQL === 'function') {
      const { sql: text, params } = (query as unknown as { toSQL(): { sql: string; params: unknown[] } }).toSQL();
      this.#statements.push({ sql: text, params });
      return this;
    }
    return this.#push(query.getSQL());
  }

  /** Insert rows, stamping `updated_seq` and `actor_id` on tables that carry them. */
  insert<T extends SQLiteTable>(table: T, rows: Writable<T> | readonly Writable<T>[]): this {
    const list = (Array.isArray(rows) ? rows : [rows]) as Record<string, unknown>[];
    if (list.length === 0) return this;
    const stamp = this.#stamp(table, false);
    return this.run(this.#orm.insert(table).values(list.map((row) => ({ ...row, ...stamp })) as never));
  }

  /** Update rows, stamping the change and incrementing `rev` on tables that carry them. */
  update<T extends SQLiteTable>(table: T, set: Partial<Writable<T>>, where: SQL): this {
    return this.run(this.#orm.update(table).set({ ...set, ...this.#stamp(table, true) } as never).where(where));
  }

  /**
   * Insert many rows with a few statements: rows travel as one JSON parameter per chunk and
   * json_each expands them inside D1 (design "Bounded request handlers").
   */
  bulkInsert<T extends SQLiteTable>(table: T, rows: readonly Writable<T>[]): this {
    if (rows.length === 0) return this;
    const columns = getTableColumns(table);
    const keys = Object.keys(rows[0]!).filter((key) => key in columns && !['updatedSeq', 'actorId', 'rev'].includes(key));
    const stamp = this.#stamp(table, false);
    const stampKeys = Object.keys(stamp);
    const target = [...keys, ...stampKeys].map((key) => sql.identifier(columns[key]!.name));
    const encoded = rows.map((row) => keys.map((key) => {
      const value = (row as Record<string, unknown>)[key];
      return value === undefined || value === null ? null : columns[key]!.mapToDriverValue(value);
    }));
    for (const chunk of chunks(encoded)) {
      const selected = [
        ...keys.map((_key, index) => sql.raw(`json_extract(value, '$[${index}]')`)),
        ...stampKeys.map((key) => (stamp as Record<string, unknown>)[key] === CHANGE_SEQ ? CHANGE_SEQ : sql`${(stamp as Record<string, unknown>)[key]}`),
      ];
      this.#push(sql`INSERT INTO ${sql.identifier(getTableName(table))} (${sql.join(target, sql`, `)}) SELECT ${sql.join(selected, sql`, `)} FROM json_each(${JSON.stringify(chunk)})`);
    }
    return this;
  }

  /** One Revision per Revision_Kind that a save involves, by the acting Member (R22.1). */
  revision(input: RevisionInput): this {
    if (this.actor.id === null) throw new Error('A Revision needs an acting Member.');
    return this.run(this.#orm.insert(revisions).values({
      id: newULID(this.actor.now), targetType: input.targetType, targetId: input.targetId, rootId: input.rootId ?? null,
      kind: input.kind, memberId: this.actor.id, at: this.actor.now, reason: input.reason ?? null, prev: input.prev,
      restoredPoint: input.restoredPoint ?? null, ai: input.ai ?? null, seq: CHANGE_SEQ,
    }));
  }

  /** Many Revisions in a few statements, for one save that changes many targets (for example the Project_Order). */
  revisions(inputs: readonly RevisionInput[]): this {
    if (inputs.length === 0) return this;
    if (this.actor.id === null) throw new Error('A Revision needs an acting Member.');
    const rows = inputs.map((input) => [
      newULID(this.actor.now), input.targetType, input.targetId, input.rootId ?? null, input.kind, input.reason ?? null,
      JSON.stringify(input.prev), input.restoredPoint ?? null, input.ai ? JSON.stringify(input.ai) : null,
    ]);
    for (const chunk of chunks(rows)) {
      this.#push(sql`INSERT INTO revisions (id, target_type, target_id, root_id, kind, reason, prev, restored_point, ai, member_id, at, seq)
        SELECT ${sql.raw([0, 1, 2, 3, 4, 5, 6, 7, 8].map((index) => `json_extract(value, '$[${index}]')`).join(', '))}, ${this.actor.id}, ${this.actor.now}, ${CHANGE_SEQ}
        FROM json_each(${JSON.stringify(chunk)})`);
    }
    return this;
  }

  /** Follow-up work for a background processor, committed with the change (design "Outbox, kick, sweep"). */
  outbox(topic: OutboxTopic, scope: string): this {
    this.#topics.add(topic);
    return this.run(this.#orm.insert(outbox).values({ topic, scope, changeSeq: CHANGE_SEQ, createdAt: this.actor.now }));
  }

  /** One outbox row per distinct scope, in one statement, in the order given. */
  outboxMany(topic: OutboxTopic, scopes: readonly string[]): this {
    const distinct = [...new Set(scopes)];
    if (distinct.length === 0) return this;
    this.#topics.add(topic);
    return this.#push(sql`INSERT INTO outbox (topic, scope, change_seq, created_at)
      SELECT ${topic}, value, ${CHANGE_SEQ}, ${this.actor.now} FROM json_each(${JSON.stringify(distinct)}) ORDER BY key`);
  }

  /**
   * Add statements that must follow all the others, once however many writes ask for them: `add` runs when the batch
   * commits, and a second call with the same `key` changes nothing.
   */
  defer(key: string, add: (batch: GuardedBatch) => void): this {
    if (!this.#deferred.has(key)) this.#deferred.set(key, add);
    return this;
  }

  /** Run the batch. A failing guard aborts everything and surfaces as a GuardViolation naming its rule. */
  async commit(accountant?: RequestAccountant): Promise<D1Result[]> {
    for (const add of this.#deferred.values()) add(this);
    this.#deferred.clear();
    if (this.size > OPERATIONS.maxD1Statements) throw new BatchTooLarge(this.size);
    const statements = [
      ...(this.options.ignoreFreeze ? [] : [this.#db.prepare(FROZEN_GUARD)]),
      this.#db.prepare(INCREMENT_CHANGE),
      ...this.#statements.map((statement) => this.#db.prepare(statement.sql).bind(...statement.params)),
    ];
    let results: D1Result[];
    try {
      results = await this.#db.batch(statements);
    } catch (error) {
      const code = guardCodeOf(error);
      throw code ? new GuardViolation(code, { cause: error }) : error;
    }
    accountant?.add(results);
    accountant?.committed(this.#topics);
    return results;
  }

  #push(query: SQL): this {
    const { sql: text, params } = this.#dialect.sqlToQuery(query);
    this.#statements.push({ sql: text, params });
    return this;
  }

  #stamp(table: SQLiteTable, updating: boolean): Record<string, unknown> {
    const columns = getTableColumns(table);
    return {
      ...('updatedSeq' in columns ? { updatedSeq: CHANGE_SEQ } : {}),
      ...('actorId' in columns ? { actorId: this.actor.id } : {}),
      ...(updating && 'rev' in columns ? { rev: sql`${sql.identifier(columns['rev']!.name)} + 1` } : {}),
    };
  }
}

/** Rows grouped so that each group's JSON stays below the size D1 accepts for one parameter. */
export function* chunks<T>(rows: readonly T[]): Generator<T[]> {
  let current: T[] = [];
  let length = 2;
  for (const row of rows) {
    const size = JSON.stringify(row).length + 1;
    if (current.length > 0 && length + size > BULK_JSON_LIMIT) {
      yield current;
      current = [];
      length = 2;
    }
    current.push(row);
    length += size;
  }
  if (current.length > 0) yield current;
}
