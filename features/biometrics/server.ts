// PURPOSE: Authenticate kiosks, issue and consume challenges, and maintain enrolled face templates.
import {
  createCipheriv, createDecipheriv, createPublicKey, randomBytes, randomUUID, verify,
} from "node:crypto";
import {
  BiometricsError, action, checkSequence, enrollment, enrollmentPayload, hash, object, proof,
  punch, punchPayload, signedIntegrityPayload, signedRequest, uuid,
} from "./protocol.ts";
import type { Punch, RequestProof } from "./protocol.ts";
import { verifyPlayIntegrity } from "./integrity.ts";
import { findRegisteredFace } from "./self-service.ts";

export { BiometricsError } from "./protocol.ts";

type Db = {
  query(sql: string, values?: unknown[]): Promise<{ rows: Record<string, unknown>[]; rowCount: number | null }>;
};
type Device = { deviceId: string; siteId: string; publicKey: string };

async function registeredDevice(tx: Db, deviceId: string, exclusive = false): Promise<Device> {
  const { rows } = await tx.query(`
    SELECT device.site_id, device.public_key
    FROM kiosk_biometric_devices device
    JOIN access_sites site ON site.id = device.site_id AND site.active
    WHERE device.device_id = $1 AND device.active
    FOR ${exclusive ? "UPDATE" : "SHARE"} OF device, site
  `, [deviceId]);
  const row = rows[0];
  if (!row || typeof row.site_id !== "string" || typeof row.public_key !== "string") {
    throw new BiometricsError("INVALID_DEVICE_PROOF", 401);
  }
  return { deviceId, siteId: row.site_id, publicKey: row.public_key };
}

function verifySignature(device: Device, payload: string, signature: string): void {
  let success = false;
  try {
    const key = createPublicKey({ key: Buffer.from(device.publicKey, "base64url"), format: "der", type: "spki" });
    const bytes = Buffer.from(signature, "base64url");
    success = bytes.toString("base64url") === signature && key.asymmetricKeyType === "ec"
      && key.asymmetricKeyDetails?.namedCurve === "prime256v1"
      && verify("sha256", Buffer.from(payload, "utf8"), key, bytes);
  } catch {
    // Key decoding and signature errors receive the same response.
  }
  if (!success) throw new BiometricsError("INVALID_DEVICE_PROOF", 401);
}

function freshProof(signed: RequestProof): void {
  const age = Date.now() - Date.parse(signed.issuedAt);
  if (age > 30000 || age < -5000) throw new BiometricsError("INVALID_DEVICE_PROOF", 401);
}

async function useProof(tx: Db, deviceId: string, signed: RequestProof) {
  const result = await tx.query(`
    INSERT INTO kiosk_biometric_requests(device_id, request_id) VALUES ($1, $2)
    ON CONFLICT DO NOTHING
  `, [deviceId, signed.requestId]);
  if (result.rowCount !== 1) throw new BiometricsError("REPLAYED_DEVICE_PROOF", 409);
}

export async function issueChallenge(tx: Db, input: unknown, header: unknown) {
  const body = object(input, "deviceId", "action");
  const deviceId = uuid(body.deviceId);
  const requestedAction = action(body.action);
  const signed = proof(header);
  const device = await registeredDevice(tx, deviceId, true);
  verifySignature(device, signedRequest("elt-challenge-v1", deviceId, signed, [requestedAction]), signed.signature);
  freshProof(signed);
  await useProof(tx, deviceId, signed);

  const { rows } = await tx.query(`
    SELECT 1 FROM kiosk_biometric_challenges
    WHERE device_id = $1 AND issued_at > clock_timestamp() - INTERVAL '1 minute'
    LIMIT 60
  `, [deviceId]);
  if (rows.length >= 60) throw new BiometricsError("KIOSK_RATE_LIMIT", 429);

  const challengeId = randomUUID();
  const nonce = randomBytes(32).toString("base64url");
  const issuedAt = new Date();
  const expiresAt = new Date(issuedAt.getTime() + 60_000);
  await tx.query(`
    INSERT INTO kiosk_biometric_challenges(challenge_id, device_id, action, nonce_hash, issued_at, expires_at)
    VALUES ($1, $2, $3, $4, $5, $6)
  `, [challengeId, deviceId, requestedAction, hash(nonce), issuedAt, expiresAt]);
  return { challengeId, nonce, expiresAt: expiresAt.toISOString() };
}

async function authenticatePunch(tx: Db, input: unknown): Promise<{ device: Device; request: Punch; payload: string }> {
  const request = punch(input);
  const device = await registeredDevice(tx, request.deviceId);
  const payload = punchPayload(request);
  verifySignature(device, signedIntegrityPayload(payload, request.evidence.integrityToken), request.evidence.signature);
  return { device, request, payload };
}

export async function verifyDeviceOrigin(tx: Db, input: unknown): Promise<void> {
  await authenticatePunch(tx, input);
}

export async function verifyEvidence(tx: Db, input: unknown) {
  const { device, request, payload } = await authenticatePunch(tx, input);
  const { employeeId, templateId, nonce, frames, integrityToken } = request.evidence;
  checkSequence(frames, true);

  const { rows } = await tx.query(`
    SELECT issued_at FROM kiosk_biometric_challenges
    WHERE challenge_id = $1 AND device_id = $2 AND action = $3 AND nonce_hash = $4
      AND consumed_at IS NULL AND expires_at > clock_timestamp()
    FOR UPDATE
  `, [request.challengeId, device.deviceId, request.action, hash(nonce)]);
  const issuedAt = rows[0]?.issued_at;
  if (!(issuedAt instanceof Date)) throw new BiometricsError("INVALID_KIOSK_CHALLENGE", 409);

  const template = await tx.query(`
    SELECT 1 FROM kiosk_face_templates template
    JOIN kiosk_face_registrations registration
      ON registration.employee_id = template.employee_id AND registration.template_id = template.template_id
    JOIN access_employee_sites assignment
      ON assignment.employee_id = template.employee_id AND assignment.site_id = $3 AND assignment.active
    JOIN access_sites site ON site.id = assignment.site_id AND site.active
    JOIN access_employees employee ON employee.id = template.employee_id AND employee.active
    WHERE template.template_id = $1 AND template.employee_id = $2 AND template.retired_at IS NULL
    FOR SHARE OF template, registration, assignment, employee, site
  `, [templateId, employeeId, device.siteId]);
  if (!template.rows.length) throw new BiometricsError("BIOMETRIC_VERIFICATION_FAILED", 403);

  await verifyPlayIntegrity(integrityToken, payload, issuedAt.getTime());
  const consumed = await tx.query(`
    UPDATE kiosk_biometric_challenges SET consumed_at = clock_timestamp()
    WHERE challenge_id = $1 AND expires_at > clock_timestamp()
  `, [request.challengeId]);
  if (consumed.rowCount !== 1) throw new BiometricsError("INVALID_KIOSK_CHALLENGE", 409);
  return { employeeId, siteId: device.siteId, deviceId: device.deviceId, challengeId: request.challengeId };
}

function templateKey(): Buffer {
  const key = process.env.KIOSK_TEMPLATE_KEY_HEX;
  if (!key || !/^[\da-f]{64}$/i.test(key)) throw new BiometricsError("KIOSK_TEMPLATES_UNAVAILABLE", 503);
  return Buffer.from(key, "hex");
}

function encryptEmbedding(embedding: number[], identity: string, key: Buffer): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(Buffer.from(identity, "utf8"));
  return Buffer.concat([iv, cipher.update(JSON.stringify(embedding)), cipher.final(), cipher.getAuthTag()]).toString("base64url");
}

function decryptEmbedding(value: string, identity: string, key: Buffer): number[] {
  try {
    const bytes = Buffer.from(value, "base64url");
    const decipher = createDecipheriv("aes-256-gcm", key, bytes.subarray(0, 12));
    decipher.setAAD(Buffer.from(identity, "utf8"));
    decipher.setAuthTag(bytes.subarray(-16));
    return JSON.parse(Buffer.concat([decipher.update(bytes.subarray(12, -16)), decipher.final()]).toString("utf8"));
  } catch {
    throw new BiometricsError("KIOSK_TEMPLATES_UNAVAILABLE", 503);
  }
}

export async function fetchRoster(tx: Db, input: unknown, header: unknown) {
  const deviceId = uuid(object(input, "deviceId").deviceId);
  const signed = proof(header);
  const device = await registeredDevice(tx, deviceId);
  verifySignature(device, signedRequest("elt-roster-v1", deviceId, signed), signed.signature);
  freshProof(signed);
  await useProof(tx, deviceId, signed);
  const key = templateKey();
  const { rows } = await tx.query(`
    SELECT template.template_id, template.site_id AS template_site_id, template.employee_id, employee.display_name, template.sealed_embedding
    FROM kiosk_face_templates template
    JOIN kiosk_face_registrations registration
      ON registration.employee_id = template.employee_id AND registration.template_id = template.template_id
    JOIN access_employee_sites assignment
      ON assignment.employee_id = template.employee_id AND assignment.site_id = $1 AND assignment.active
    JOIN access_sites site ON site.id = assignment.site_id AND site.active
    JOIN access_employees employee ON employee.id = template.employee_id AND employee.active
    WHERE template.retired_at IS NULL
    ORDER BY template.employee_id
    FOR SHARE OF template, registration, assignment, site, employee
  `, [device.siteId]);
  return {
    templates: rows.map(row => ({
      employeeId: row.employee_id as string,
      displayName: row.display_name as string,
      templateId: row.template_id as string,
      embedding: decryptEmbedding(row.sealed_embedding as string, `${row.template_site_id}/${row.employee_id}/${row.template_id}`, key),
    })),
  };
}

export async function enrollFace(tx: Db, input: unknown) {
  const request = enrollment(input);
  const { deviceId, employeeId, setupCode, embedding, frames, integrityToken } = request;
  const device = await registeredDevice(tx, deviceId);
  const payload = enrollmentPayload(request);
  verifySignature(device, signedIntegrityPayload(payload, integrityToken), request.signature);
  freshProof(request);
  checkSequence(frames, false);
  await useProof(tx, deviceId, request);
  const key = templateKey();

  await tx.query(`INSERT INTO kiosk_face_registrations(employee_id) VALUES ($1) ON CONFLICT (employee_id) DO NOTHING`, [employeeId]);
  const registration = await tx.query(`SELECT registration_revision,template_id FROM kiosk_face_registrations WHERE employee_id = $1 FOR UPDATE`, [employeeId]);
  if (!registration.rows[0] || registration.rows[0].template_id) throw new BiometricsError("FACE_ALREADY_REGISTERED", 409);
  const revision = Number(registration.rows[0].registration_revision);

  const code = await tx.query(`
    DELETE FROM kiosk_face_enrollment_codes
    WHERE code_hash = $1 AND device_id = $2 AND employee_id = $3 AND expires_at > clock_timestamp()
    RETURNING code_hash
  `, [hash(setupCode), deviceId, employeeId]);
  if (!code.rows.length) throw new BiometricsError("KIOSK_ENROLLMENT_REJECTED", 403);

  const assignment = await tx.query(`
    SELECT 1 FROM access_employee_sites assignment
    JOIN access_employees employee ON employee.id = assignment.employee_id AND employee.active
    WHERE assignment.employee_id = $1 AND assignment.site_id = $2 AND assignment.active
    FOR SHARE OF assignment, employee
  `, [employeeId, device.siteId]);
  if (!assignment.rows.length) throw new BiometricsError("KIOSK_ENROLLMENT_REJECTED", 403);
  await verifyPlayIntegrity(integrityToken, payload, Date.parse(request.issuedAt) - 5000);
  const registeredName = await findRegisteredFace(tx, embedding, employeeId);
  if (registeredName) throw new BiometricsError("FACE_ALREADY_REGISTERED", 409, { registeredName });

  const templateId = randomUUID();
  const sealed = encryptEmbedding(embedding, `${device.siteId}/${employeeId}/${templateId}`, key);
  const inserted = await tx.query(`
    INSERT INTO kiosk_face_templates(template_id, site_id, employee_id, sealed_embedding)
    VALUES ($1, $2, $3, $4)
    ON CONFLICT DO NOTHING
    RETURNING template_id
  `, [templateId, device.siteId, employeeId, sealed]);
  if (inserted.rowCount !== 1) throw new BiometricsError("FACE_ALREADY_REGISTERED", 409);
  const linked = await tx.query(`
    UPDATE kiosk_face_registrations SET template_id = $2,registered_at = clock_timestamp(),updated_at = clock_timestamp()
     WHERE employee_id = $1 AND registration_revision = $3 AND template_id IS NULL
  `, [employeeId, templateId, revision]);
  if (linked.rowCount !== 1) throw new BiometricsError("FACE_REGISTRATION_CONFLICT", 409);
  return { employeeId, templateId };
}

export {
  approveFaceEnrollment,
  cancelFaceEnrollment,
  claimFaceEnrollment,
  completeFaceEnrollment,
  generateEnrollmentCode,
  getFaceEnrollmentSessionStatus,
  getFaceEnrollmentStatus,
  issueFaceEnrollmentCode,
  listFaceEnrollmentQueue,
  requestFaceReregistration,
  resetFaceRegistration,
  siteScopedEnrollmentDigest,
} from "./self-service.ts";
export type {
  ClaimEnrollmentInput,
  ClaimEnrollmentResult,
  CompleteEnrollmentInput,
  EnrollmentSessionStatus,
  FaceEnrollmentStatus,
  IssueEnrollmentResult,
  IssuedEnrollmentCode,
  ResetFaceRegistrationInput,
} from "./self-service.ts";
