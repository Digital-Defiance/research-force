import { createExecutionContext, env, runInDurableObject } from 'cloudflare:test';
import { describe, expect, inject, it } from 'vitest';
import { fc, FC_RUNS } from '@researchforce/testing/fc';
import type { Env } from '../src/env';
import app from '../src/index';

const bindings = env as unknown as Env;

describe('local Cloudflare runtime', () => {
  it('honors the property-test run override inside workerd', () => {
    expect(FC_RUNS).toBe(inject('fcRuns'));
    expect(fc.readConfigureGlobal().numRuns).toBe(FC_RUNS);
  });
  it('has D1 with the intended FTS5 tokenizer', async () => {
    await bindings.RF_SEARCH.exec("CREATE VIRTUAL TABLE scaffold_fts USING fts5(body, tokenize = 'unicode61 remove_diacritics 2');");
    try {
      await bindings.RF_SEARCH.prepare('INSERT INTO scaffold_fts (body) VALUES (?)').bind('Synthetic café research').run();
      const row = await bindings.RF_SEARCH.prepare('SELECT body FROM scaffold_fts WHERE scaffold_fts MATCH ?').bind('cafe').first<{ body: string }>();
      expect(row?.body).toBe('Synthetic café research');
    } finally { await bindings.RF_SEARCH.exec('DROP TABLE scaffold_fts;'); }
    expect(await bindings.RF_CORE.prepare('SELECT 1 AS ok').first('ok')).toBe(1);
    expect(await bindings.RF_PUBLIC.prepare('SELECT 1 AS ok').first('ok')).toBe(1);
  });

  it('round-trips synthetic data through both R2 buckets', async () => {
    for (const bucket of [bindings.RF_PRIVATE_BUCKET, bindings.RF_PUBLIC_BUCKET]) {
      await bucket.put('scaffold/synthetic.txt', 'Synthetic fixture');
      try { expect(await (await bucket.get('scaffold/synthetic.txt'))?.text()).toBe('Synthetic fixture'); }
      finally { await bucket.delete('scaffold/synthetic.txt'); }
    }
  });

  it('provides SQLite storage in each Durable Object class', async () => {
    for (const namespace of [bindings.PUBLISHER, bindings.MAILER, bindings.BUDGET, bindings.JOBS]) {
      const stub = namespace.get(namespace.idFromName('scaffold-runtime-test'));
      await runInDurableObject(stub, async (_instance, state) => {
        state.storage.sql.exec('CREATE TABLE IF NOT EXISTS scaffold (value TEXT NOT NULL)');
        state.storage.sql.exec('DELETE FROM scaffold');
        state.storage.sql.exec('INSERT INTO scaffold VALUES (?)', 'synthetic');
        expect(state.storage.sql.exec<{ value: string }>('SELECT value FROM scaffold').one().value).toBe('synthetic');
        state.storage.sql.exec('DROP TABLE scaffold');
      });
    }
  });

  it('sends API requests through Access verification, which fails closed without the Access secrets', async () => {
    expect(bindings.WORKSPACE_ORIGIN).toBe('https://app.researchforce.org');
    for (const path of ['/api/v1/me', '/api/v1/no-such-route', '/api/']) {
      const request = new Request(`https://app.researchforce.org${path}`, { headers: { 'Cf-Access-Jwt-Assertion': 'eyJhbGciOiJub25lIn0.e30.' } });
      const response = await app.fetch(request as Parameters<typeof app.fetch>[0], bindings, createExecutionContext());
      expect(response.status).toBe(401);
      expect(await response.json()).toEqual({ error: 'unauthenticated' });
    }
  });
});
