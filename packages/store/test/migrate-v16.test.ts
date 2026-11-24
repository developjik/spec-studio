import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { describe, it, expect } from 'vitest';
import { applySchema, splitSchema } from '../src/schema';

describe('v15 proposal queue migration', () => {
  it('preserves existing proposal history and adds nullable source and stable order defaults', () => {
    const db = new DatabaseSync(':memory:');
    try {
      db.exec(splitSchema(readFileSync(new URL('./fixtures/schema-v15.sql', import.meta.url), 'utf8')).core);
      db.exec("PRAGMA foreign_keys = OFF; INSERT INTO proposal(id, doc_id, origin, summary, base_rev, author_kind, state, created_at, decided_at) VALUES ('PR_aaaaaaaaaaaa', 'D_aaaaaaaaaaaa', 'screen', 'before', 2, 'ai', 'adopted', '2026-11-19T00:00:00Z', '2026-11-19T01:00:00Z')");
      expect(applySchema(db).actual).toBe(16);
      expect(db.prepare('SELECT summary,state,base_rev,queue_order,queued_at,source FROM proposal').get()).toMatchObject({summary: 'before', state: 'adopted', base_rev: 2, queue_order: 0, queued_at: null, source: null});
      expect(applySchema(db).created).toBe(false);
    } finally { db.close(); }
  });
});
