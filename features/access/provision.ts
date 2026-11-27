// PURPOSE: Provision kiosk people and reader scope through an offline database operator command.
import pg from 'pg';
import { linkSignup } from './access.ts';

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function requireUuid(value: string | undefined): string {
  if (!value || !uuid.test(value)) throw new Error('Expected a UUID');
  return value;
}

function requireText(value: string | undefined): string {
  if (!value || !value.trim() || value.length > 512) throw new Error('Expected nonempty text up to 512 characters');
  return value.trim();
}

async function main(): Promise<void> {
  const databaseUrl = process.env.ACCESS_DATABASE_URL;
  if (!databaseUrl) throw new Error('ACCESS_DATABASE_URL is required');
  const [command, ...args] = process.argv.slice(2);
  const client = new pg.Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    await client.query('BEGIN');
    switch (command) {
      case 'employee': {
        if (args.length !== 2) throw new Error('Usage: employee UUID DISPLAY_NAME');
        await client.query(
          `INSERT INTO access_employees (id, display_name) VALUES ($1, $2)
           ON CONFLICT (id) DO UPDATE SET display_name = EXCLUDED.display_name, active = true`,
          [requireUuid(args[0]), requireText(args[1])],
        );
        break;
      }
      case 'site': {
        if (args.length !== 2) throw new Error('Usage: site UUID NAME');
        await client.query(
          `INSERT INTO access_sites (id, name) VALUES ($1, $2)
           ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, active = true`,
          [requireUuid(args[0]), requireText(args[1])],
        );
        break;
      }
      case 'assign-site': {
        if (args.length !== 2) throw new Error('Usage: assign-site EMPLOYEE_UUID SITE_UUID');
        await client.query(
          `INSERT INTO access_employee_sites (employee_id, site_id) VALUES ($1, $2)
           ON CONFLICT (employee_id, site_id) DO UPDATE SET active = true`,
          [requireUuid(args[0]), requireUuid(args[1])],
        );
        break;
      }
      case 'link-subject': {
        if (args.length !== 2 || process.stdin.isTTY) {
          throw new Error('Usage: link-subject PROVIDER EMPLOYEE_UUID < SUBJECT_FILE');
        }
        let subjectInput = '';
        for await (const chunk of process.stdin) {
          subjectInput += chunk.toString();
          if (subjectInput.length > 514) throw new Error('Subject input too long');
        }
        const subject = requireText(subjectInput.trim());
        await client.query(
          `INSERT INTO access_subject_links (auth_provider, auth_subject, employee_id)
           VALUES ($1, $2, $3)`,
          [requireText(args[0]), subject, requireUuid(args[1])],
        );
        break;
      }
      case 'operator-role': {
        if (args.length !== 2 || !['HR', 'ADMIN'].includes(args[1] ?? '')) {
          throw new Error('Usage: operator-role EMPLOYEE_UUID HR|ADMIN');
        }
        await client.query(
          `INSERT INTO access_operator_roles (employee_id, role) VALUES ($1, $2)
           ON CONFLICT (employee_id) DO UPDATE SET role = EXCLUDED.role, active = true`,
          [requireUuid(args[0]), args[1]],
        );
        break;
      }
      case 'manager-report': {
        if (args.length !== 2) throw new Error('Usage: manager-report MANAGER_UUID REPORT_UUID');
        await client.query(
          `INSERT INTO access_manager_reports (manager_id, report_id) VALUES ($1, $2)
           ON CONFLICT (manager_id, report_id) DO UPDATE SET active = true`,
          [requireUuid(args[0]), requireUuid(args[1])],
        );
        break;
      }
      case 'whatsapp': {
        if (args.length !== 2 || !/^\+[1-9][0-9]{7,14}$/.test(args[1] ?? '')) throw new Error('Usage: whatsapp EMPLOYEE_UUID +E164_NUMBER');
        await client.query('UPDATE access_employees SET whatsapp_number = $2 WHERE id = $1', [requireUuid(args[0]), args[1]]);
        break;
      }
      case 'approve-signup': {
        // Bootstraps the first admin (nobody can approve them in the app yet); add `operator-role` afterwards.
        if (args.length !== 1) throw new Error('Usage: approve-signup EMAIL');
        const request = await client.query<{ request_id: string }>(
          'SELECT request_id FROM access_signup_requests WHERE lower(email) = lower($1)', [requireText(args[0])]);
        if (request.rows.length !== 1) throw new Error('Usage: approve-signup EMAIL (the person must sign up in the app first)');
        const created = await linkSignup(client, request.rows[0]!.request_id);
        process.stdout.write(`Employee ${created.employeeCode} ${created.employeeId}
`);
        break;
      }
      case 'deactivate-employee': {
        if (args.length !== 1) throw new Error('Usage: deactivate-employee EMPLOYEE_UUID');
        await client.query('UPDATE access_employees SET active = false WHERE id = $1', [requireUuid(args[0])]);
        break;
      }
      default:
        throw new Error('Unknown provisioning command');
    }
    await client.query('COMMIT');
    process.stdout.write('Provisioned\n');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    await client.end();
  }
}

main().catch((error: unknown) => {
  // Database errors may include connection details or subject values; do not print them.
  process.stderr.write(error instanceof Error && error.message.startsWith('Usage:') ? `${error.message}\n` : 'Provisioning failed\n');
  process.exitCode = 1;
});
