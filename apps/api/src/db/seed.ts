import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { gunzipSync } from 'node:zlib';
import pg from 'pg';

const usdaFile = fileURLToPath(new URL('../../data/usda_sr_legacy.json.gz', import.meta.url));

interface UsdaFile {
  columns: ['id', 'name', 'kcal', 'protein_g', 'carb_g', 'fat_g', 'fiber_g'];
  rows: [string, string, number, number, number, number, number | null][];
}

/**
 * Loads the bundled reference foods (USDA SR Legacy, per 100 g) when the
 * table is empty. Runs as the schema owner after migrations, on every boot;
 * a no-op once seeded.
 */
export async function seedReferenceFoods(ownerUrl: string): Promise<number> {
  const pool = new pg.Pool({ connectionString: ownerUrl, max: 1, application_name: 'macrotracker-seed' });
  try {
    const { rows } = await pool.query<{ n: string }>('select count(*) as n from app.reference_foods');
    if (Number(rows[0]!.n) > 0) return 0;
    const data = JSON.parse(gunzipSync(readFileSync(usdaFile)).toString('utf8')) as UsdaFile;
    const client = await pool.connect();
    try {
      await client.query('begin');
      for (let i = 0; i < data.rows.length; i += 1000) {
        const batch = data.rows.slice(i, i + 1000);
        const values: unknown[] = [];
        const tuples = batch.map((r, j) => {
          values.push(...r);
          const b = j * 7;
          return `($${b + 1}, $${b + 2}, 100, 'g', $${b + 3}, $${b + 4}, $${b + 5}, $${b + 6}, $${b + 7}, 'usda')`;
        });
        await client.query(
          `insert into app.reference_foods
             (id, name, serving_qty, serving_unit, kcal_per_serving, protein_g, carb_g, fat_g, fiber_g, source)
           values ${tuples.join(', ')} on conflict (id) do nothing`,
          values,
        );
      }
      await client.query('commit');
    } catch (err) {
      await client.query('rollback');
      throw err;
    } finally {
      client.release();
    }
    return data.rows.length;
  } finally {
    await pool.end();
  }
}
