import { readFileSync } from 'node:fs';
import { SYNC_TABLES, type SyncTable, syncRowSchemas } from '@macrotracker/shared';
import { describe, expect, it } from 'vitest';
import { validateRow } from '../../src/services/sync.js';

/**
 * Rows exactly as the app uploads them, written by the app's own code paths
 * (app repo `test/sync/wire_rows_test.dart`, copied here by
 * scripts/sync-engine-fixtures.sh). Every row must validate, and the server
 * must know every column: an unknown one would be dropped silently.
 */
const fixture = JSON.parse(
  readFileSync(new URL('../../../../fixtures/sync/wire_rows.json', import.meta.url), 'utf8'),
) as Record<SyncTable, Record<string, unknown>[]>;

describe('rows from the app', () => {
  it('cover every synced table', () => {
    expect(Object.keys(fixture).sort()).toEqual([...SYNC_TABLES].sort());
  });

  it.each(SYNC_TABLES)('%s rows validate with every column known', (table) => {
    const known = Object.keys(syncRowSchemas[table].shape);
    for (const row of fixture[table]) {
      expect(() => validateRow(table, row)).not.toThrow();
      expect(known).toEqual(expect.arrayContaining(Object.keys(row)));
    }
  });

  it('accepts the long ids recipe items use', () => {
    const item = fixture.recipe_items[0]!;
    expect(String(item.id).length).toBeGreaterThan(64);
  });
});
