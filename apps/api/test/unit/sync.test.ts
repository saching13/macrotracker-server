import { SYNC_TABLES } from '@macrotracker/shared';
import { describe, expect, it } from 'vitest';
import { Rejection, serverTime, validateRow } from '../../src/services/sync.js';
import { sampleRow } from '../fixtures/sync-rows.js';

describe('serverTime', () => {
  const now = new Date('2026-11-02T12:00:00.000Z');

  it('shifts a stamp by the gap between the clocks', () => {
    // The phone runs 10 minutes fast; its edit was 1 minute before it pushed.
    expect(serverTime('2026-11-02T12:09:00.000Z', '2026-11-02T12:10:00.000Z', now).toISOString()).toBe(
      '2026-11-02T11:59:00.000Z',
    );
    expect(serverTime('2026-11-02T11:49:00.000Z', '2026-11-02T11:50:00.000Z', now).toISOString()).toBe(
      '2026-11-02T11:59:00.000Z',
    );
  });

  it('never stamps the future', () => {
    expect(serverTime('2026-11-03T00:00:00.000Z', '2026-11-02T12:00:00.000Z', now)).toEqual(now);
  });
});

describe('validateRow', () => {
  it.each(SYNC_TABLES)('accepts a sample %s row', (table) => {
    const { values } = validateRow(table, sampleRow(table));
    expect(Object.keys(values).length).toBeGreaterThan(1);
  });

  it('maps wire columns to schema properties', () => {
    const row = sampleRow('log_entries');
    const { key, values } = validateRow('log_entries', row);
    expect(key).toBe(row.id);
    expect(values).toMatchObject({ localDate: '2026-10-30', proteinG: 15.5, loggedTime: '07:30' });
  });

  const rejects = (fn: () => unknown, code: string) => {
    try {
      fn();
    } catch (err) {
      expect(err).toBeInstanceOf(Rejection);
      expect((err as Rejection).code).toBe(code);
      return;
    }
    throw new Error('expected a rejection');
  };

  it('keeps reference foods and device settings off the server', () => {
    rejects(() => validateRow('foods', sampleRow('foods', { source: 'indb' })), 'reference_food');
    rejects(() => validateRow('foods', sampleRow('foods', { source: 'usda' })), 'reference_food');
    rejects(() => validateRow('app_meta', { key: 'backup_provider', value: 'x' }), 'meta_key_not_synced');
    rejects(() => validateRow('app_meta', { key: 'indb_enabled', value: 'true' }), 'meta_key_not_synced');
  });

  it('checks types, formats and ranges', () => {
    rejects(() => validateRow('log_entries', sampleRow('log_entries', { kcal: Number.NaN })), 'invalid_row');
    rejects(
      () => validateRow('weight_entries', sampleRow('weight_entries', { weight_kg: -1 })),
      'invalid_row',
    );
    rejects(() => validateRow('targets', sampleRow('targets', { weekday: 8 })), 'invalid_row');
    rejects(() => validateRow('foods', sampleRow('foods', { is_favorite: true })), 'invalid_row');
    rejects(() => validateRow('user_profile', sampleRow('user_profile', { id: 'you' })), 'invalid_row');
    rejects(() => validateRow('log_entries', sampleRow('log_entries', { id: 'a b' })), 'invalid_row');
    rejects(() => validateRow('log_entries', 'not a row'), 'invalid_row');
  });
});
