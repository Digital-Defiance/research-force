import { Hono } from 'hono';
import type { Context } from 'hono';
import { sql } from 'drizzle-orm';
import { CHANGE_SEQ, GuardedBatch } from '@researchforce/db/batch';
import { isAdministrator } from '@researchforce/domain/permissions';
import { SETTINGS, validateSetting } from '@researchforce/domain/settings';
import type { SettingKey, SettingMember } from '@researchforce/domain/settings';
import type { Timestamp, ULID } from '@researchforce/domain/types';
import { canonicalJson } from '@researchforce/kernel/views';
import { authorize, authorizeRead, permissionContext } from '../../auth/authorize';
import type { PermissionCheck } from '../../auth/authorize';
import type { ApiEnv } from '../app';
import { ApiError } from '../errors';
import type { FieldIssue } from '../errors';
import { readJson } from '../input';

const SETTING_KEYS = Object.keys(SETTINGS) as SettingKey[];
const isSettingKey = (key: string): key is SettingKey => Object.hasOwn(SETTINGS, key);

export interface SettingView { readonly value: unknown; readonly default: unknown; readonly allowed: string; readonly updatedAt: Timestamp | null; readonly updatedBy: ULID | null }

/** Every workspace-wide setting with its value, default, and allowed values; a setting never saved has its default. */
async function currentSettings(c: Context<ApiEnv>): Promise<Record<SettingKey, SettingView>> {
  const rows = await c.get('accountant').track(c.env.RF_CORE.prepare('SELECT key, value, updated_by AS updatedBy, updated_at AS updatedAt FROM settings')
    .all<{ key: string; value: string; updatedBy: ULID | null; updatedAt: Timestamp }>());
  const saved = new Map(rows.results.map((row) => [row.key, row]));
  return Object.fromEntries(SETTING_KEYS.map((key) => {
    const row = saved.get(key);
    return [key, { value: row ? JSON.parse(row.value) as unknown : SETTINGS[key].default, default: SETTINGS[key].default, allowed: SETTINGS[key].allowed, updatedAt: row?.updatedAt ?? null, updatedBy: row?.updatedBy ?? null }];
  })) as Record<SettingKey, SettingView>;
}

export const settingsRoutes = new Hono<ApiEnv>();

settingsRoutes.get('/', async (c) => {
  await authorizeRead(c);
  return c.json({ settings: await currentSettings(c) });
});

/**
 * Change one or more settings, each checked by its validator; one value outside its allowed range refuses the whole
 * request and keeps every previous value, stating the allowed range (R10.8, R20.14, R20.25, R28.12, R44.15).
 */
settingsRoutes.put('/', async (c) => {
  const body = await readJson(c);
  if (typeof body !== 'object' || body === null || Array.isArray(body) || Object.keys(body).length === 0) {
    throw new ApiError('validation', { fields: [{ field: '$', rule: 'Send an object naming at least one setting and its new value.' }] });
  }
  const input = body as Record<string, unknown>;
  const unknown = Object.keys(input).filter((key) => !isSettingKey(key));
  if (unknown.length > 0) throw new ApiError('validation', { fields: unknown.map((field) => ({ field, rule: 'Choose a supported workspace setting.' })) });
  const keys = Object.keys(input) as SettingKey[];

  const designates = Object.hasOwn(input, 'responsiblePerson');
  const members = designates
    ? (await c.get('accountant').track(c.env.RF_CORE.prepare('SELECT id, status FROM members').all<SettingMember>())).results
    : [];
  const checks: PermissionCheck[] = keys.filter((key) => key !== 'responsiblePerson').map((key) => ({ permission: 'settings.edit', target: { type: 'setting', key } }));
  if (designates) {
    const candidate = members.find((member) => member.id === input['responsiblePerson']);
    if (candidate?.status === 'active') checks.push({ permission: 'settings.edit', target: { type: 'setting', key: 'responsiblePerson', candidateMember: candidate } });
    // An Administrator who names someone else is told why below; anyone else is refused outright (R46.39).
    else if (!isAdministrator(await permissionContext(c))) throw new ApiError('forbidden');
  }
  if (checks.length > 0) await authorize(c, checks);

  const issues: FieldIssue[] = [];
  const allowed: Partial<Record<SettingKey, string>> = {};
  const values = new Map<SettingKey, unknown>();
  for (const key of keys) {
    const result = validateSetting(key, input[key], { members });
    if (result.ok) values.set(key, result.value);
    else {
      issues.push(...result.issues.map((issue) => ({ field: issue.field, rule: issue.message })));
      allowed[key] = SETTINGS[key].allowed;
    }
  }
  if (issues.length > 0) throw new ApiError('validation', { fields: issues, details: { allowed } });

  const current = await currentSettings(c);
  const changed = [...values].filter(([key, value]) => canonicalJson(current[key].value) !== canonicalJson(value));
  if (changed.length === 0) return c.json({ settings: current });
  const actor = c.get('session').member.id;
  const now = c.get('now');
  const batch = new GuardedBatch(c.env.RF_CORE, { id: actor, now });
  for (const [key, value] of changed) {
    batch.run(sql`INSERT INTO settings (key, value, updated_by, updated_at, updated_seq, actor_id) VALUES (${key}, ${JSON.stringify(value)}, ${actor}, ${now}, ${CHANGE_SEQ}, ${actor})
      ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_by = excluded.updated_by, updated_at = excluded.updated_at, updated_seq = excluded.updated_seq, actor_id = excluded.actor_id`);
  }
  if (changed.some(([key]) => key === 'responsiblePerson')) {
    // The designation is a Minor_Edit of the Privacy page that keeps the previous Responsible_Person (R46.37).
    batch.revision({ targetType: 'policy_page', targetId: 'privacy', kind: 'minor_edit', prev: { responsiblePerson: current.responsiblePerson.value } })
      .outbox('publish', 'policy:privacy');
  }
  await batch.commit(c.get('accountant'));
  return c.json({ settings: await currentSettings(c) });
});
