// PURPOSE: Register a supervised kiosk public key or authorize one supervised face enrollment.
import { createPublicKey } from "node:crypto";
import pg from "pg";
import { hash, opaque, uuid } from "./protocol.ts";

async function inputCode(): Promise<string> {
  if (process.stdin.isTTY) throw new Error("Supply the enrollment code on standard input");
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of process.stdin) {
    const data = Buffer.from(chunk);
    size += data.length;
    if (size > 46) throw new Error("Invalid enrollment code");
    chunks.push(data);
  }
  return opaque(Buffer.concat(chunks).toString("utf8").trim(), 43, 43);
}

async function main() {
  const [command, id, owner, keyText] = process.argv.slice(2);
  const deviceId = uuid(id);
  const relatedId = uuid(owner);
  const database = process.env.DATABASE_URL;
  if (!database) throw new Error("Database unavailable");

  const client = new pg.Client({ connectionString: database });
  try {
    await client.connect();
    await client.query("BEGIN");
    if (command === "register" && keyText) {
      const canonical = opaque(keyText, 120, 124);
      const bytes = Buffer.from(canonical, "base64url");
      const key = createPublicKey({ key: bytes, type: "spki", format: "der" });
      if (bytes.toString("base64url") !== canonical || key.asymmetricKeyType !== "ec"
          || key.asymmetricKeyDetails?.namedCurve !== "prime256v1") throw new Error("Invalid public key");
      const result = await client.query(`
        INSERT INTO kiosk_biometric_devices(device_id, site_id, public_key)
        SELECT $1, id, $3 FROM access_sites WHERE id = $2 AND active
        ON CONFLICT DO NOTHING
      `, [deviceId, relatedId, canonical]);
      if (result.rowCount !== 1) throw new Error("Device or site unavailable");
    } else if (command === "enrollment-code" && !keyText) {
      const codeHash = hash(await inputCode());
      const assignment = await client.query(`
        SELECT 1 FROM kiosk_biometric_devices device
        JOIN access_sites site ON site.id = device.site_id AND site.active
        JOIN access_employee_sites assignment ON assignment.site_id = site.id AND assignment.active
        JOIN access_employees employee ON employee.id = assignment.employee_id AND employee.active
        WHERE device.device_id = $1 AND employee.id = $2 AND device.active
        FOR UPDATE OF device
      `, [deviceId, relatedId]);
      if (assignment.rowCount !== 1) throw new Error("Active device and employee site assignment required");
      await client.query("DELETE FROM kiosk_face_enrollment_codes WHERE device_id = $1 AND employee_id = $2", [deviceId, relatedId]);
      await client.query(`
        INSERT INTO kiosk_face_enrollment_codes(code_hash, device_id, employee_id, expires_at)
        VALUES ($1, $2, $3, clock_timestamp() + INTERVAL '15 minutes')
      `, [codeHash, deviceId, relatedId]);
    } else {
      throw new Error("Invalid provisioning command");
    }
    await client.query("COMMIT");
    process.stdout.write("Kiosk provisioning saved.\n");
  } finally {
    await client.end();
  }
}

main().catch(() => {
  process.stderr.write("Kiosk provisioning failed. Check the command and active device, site, and employee records.\n");
  process.exitCode = 1;
});
