// PURPOSE: Apply each feature migration once, with checksum validation and a DB lock.
import { readdir, readFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { resolve, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { Pool } from 'pg'
import { database, transaction } from '../platform/db.ts'

export async function migrate(pool: Pool, root = resolve('features')) {
  return transaction(async client => {
    await client.query("SELECT pg_advisory_xact_lock(hashtext('elt_schema_migrations'))")
    await client.query('CREATE TABLE IF NOT EXISTS elt_schema_migrations (name text PRIMARY KEY, checksum text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now())')
    for (const feature of ['access', 'leave', 'schedule', 'biometrics', 'attendance', 'corrections']) {
      const dir = join(root,feature,'migrations')
      const files = (await readdir(dir)).filter(file => file.endsWith('.sql')).sort()
      if (!files.length) throw new Error('Missing migrations for ' + feature)
      for (const file of files) {
        const name = feature + '/' + file
        const sql = await readFile(join(dir,file), 'utf8')
        const checksum = createHash('sha256').update(sql.replaceAll('\r\n','\n')).digest('hex')
        const prior = await client.query('SELECT checksum FROM elt_schema_migrations WHERE name=$1',[name])
        if (prior.rows.length) {
          if (checksum !== prior.rows[0].checksum) throw new Error('Changed migration: ' + name)
          continue
        }
        await client.query(sql)
        await client.query('INSERT INTO elt_schema_migrations(name,checksum) VALUES ($1,$2)',[name,checksum])
      }
    }
    // Supabase deployments may grant public-schema tables to Data API roles by default.
    // Only the server's database owner/privileged role should access these HR records.
    await client.query(`
      DO $secure$
      DECLARE t text; r text;
      BEGIN
        FOREACH t IN ARRAY ARRAY['elt_schema_migrations','access_employees','access_sites',
          'access_employee_sites','access_subject_links','access_operator_roles','access_manager_reports',
          'kiosk_biometric_devices','kiosk_biometric_requests','kiosk_biometric_challenges',
          'kiosk_face_templates','kiosk_face_enrollment_codes','attendance_punches','attendance_audit','attendance_outbox',
          'correction_requests','correction_days','leave_work_dates','leave_balances','leave_requests','leave_decisions',
          'schedule_shifts','schedule_holidays','schedule_assignments','schedule_audit']
        LOOP
          EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
          EXECUTE format('REVOKE ALL ON TABLE %I FROM PUBLIC', t);
          FOREACH r IN ARRAY ARRAY['anon','authenticated'] LOOP
            IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname=r) THEN
              EXECUTE format('REVOKE ALL ON TABLE %I FROM %I', t, r);
            END IF;
          END LOOP;
        END LOOP;
      END $secure$`)
  }, pool)
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const pool = database()
  try { await migrate(pool) } finally { await pool.end() }
}
