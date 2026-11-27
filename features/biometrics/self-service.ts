// PURPOSE: Own employee self-service face enrollment, kiosk session recovery, and HR reset transactions.
import {
  createCipheriv, createDecipheriv, createHmac, createPublicKey, randomBytes, randomInt, randomUUID, verify,
} from "node:crypto";
import {
  BiometricsError, hash, object, proof, signedIntegrityPayload, signedRequest, uuid,
} from "./protocol.ts";
import type { Frame, RequestProof } from "./protocol.ts";
import { verifyPlayIntegrity } from "./integrity.ts";
import { AccessDeniedError, authorizeFaceRegistrationReset, authorizeHrOperator, listActiveSiteAssignments } from "../access/access.ts";
import type { Actor } from "../access/access.ts";

type Db = {
  query<R extends Record<string, unknown> = Record<string, unknown>>(
    sql: string,
    values?: unknown[],
  ): Promise<{ rows: R[]; rowCount: number | null }>;
};
type RegisteredDevice = { deviceId: string; siteId: string; publicKey: string };
type State = "issued" | "claimed" | "completed" | "expired" | "cancelled" | "superseded" | "not_found";

export interface FaceEnrollmentStatus {
  registered: boolean;
  registrationRevision: number;
  registrationAvailable: boolean;
  eligibleSites: { siteId: string; siteName: string }[];
  attendanceReadiness: { activeEmployee: boolean; activeSiteAssignmentCount: number };
  activeCodeRequest: null | { requestId: string; siteId: string; state: "issued"; expiresAt: string };
  notice: null | { version: string; text: string };
  canReset: boolean;
  employeeId: string;
  displayName: string;
  employeeCode: string | null;
  approvalPending: boolean;
  reregistrationRequested: boolean;
}
export interface IssuedEnrollmentCode {
  state: "issued";
  requestId: string;
  siteId: string;
  code: string | null;
  expiresAt: string;
  recovered: boolean;
}
export interface EnrollmentRateLimited { state: "rate_limited"; waitSeconds: number }
export type IssueEnrollmentResult = IssuedEnrollmentCode | EnrollmentRateLimited;
export interface ClaimEnrollmentInput { deviceId: string; requestId: string; code: string }
export type ClaimEnrollmentResult =
  | { state: "claimed"; sessionId: string; claimRequestId: string; employeeFirstName: string; siteName: string; registrationRevision: number; notice: { version: string; text: string }; captureExpiresAt: string }
  | { state: "rejected"; code: "KIOSK_ENROLLMENT_REJECTED" }
  | EnrollmentRateLimited;
export interface CompleteEnrollmentInput {
  deviceId: string;
  claimRequestId: string;
  sessionId: string;
  requestId: string;
  issuedAt: string;
  consentVersion: string;
  consented: true;
  embedding: number[];
  frames: Frame[];
  integrityToken: string;
  signature: string;
}
export type EnrollmentSessionStatus = {
  state: State;
  sessionId?: string;
  claimRequestId: string;
  employeeFirstName?: string;
  siteName?: string;
  completedAt?: string;
};
export interface ResetFaceRegistrationInput { employeeId: string; requestId: string; reason: string }

const noticeConfig = () => {
  const version = process.env.KIOSK_FACE_ENROLLMENT_NOTICE_VERSION;
  const text = process.env.KIOSK_FACE_ENROLLMENT_NOTICE_TEXT;
  if (!version || !version.trim() || version.length > 100 || !text || !text.trim() || text.length > 12000) return null;
  return { version, text };
};
const fail = (code: string, status = 400) => new BiometricsError(code, status);
const iso = (value: unknown): string => value instanceof Date ? value.toISOString() : new Date(String(value)).toISOString();

function digestKey(): Buffer {
  const text = process.env.KIOSK_ENROLLMENT_CODE_KEY_HEX;
  if (!text || !/^[\da-f]{64}$/i.test(text)) throw fail("KIOSK_ENROLLMENT_UNAVAILABLE", 503);
  return Buffer.from(text, "hex");
}

/** Generate a uniform six-digit decimal code as a string, retaining leading zeroes. */
export function generateEnrollmentCode(): string {
  return randomInt(0, 1_000_000).toString().padStart(6, "0");
}

/** Domain-separate and bind each keyed digest to the selected site. */
export function siteScopedEnrollmentDigest(siteId: string, code: string, key = digestKey()): string {
  return createHmac("sha256", key).update(`elt-face-enrollment-code-v1\0${siteId}\0${code}`, "utf8").digest("base64url");
}

async function lockRegistration(tx: Db, employeeId: string) {
  await tx.query(`INSERT INTO kiosk_face_registrations(employee_id) VALUES ($1) ON CONFLICT (employee_id) DO NOTHING`, [employeeId]);
  const { rows } = await tx.query(`SELECT registration_revision, template_id, approved_at FROM kiosk_face_registrations WHERE employee_id = $1 FOR UPDATE`, [employeeId]);
  if (!rows[0]) throw fail("FACE_REGISTRATION_UNAVAILABLE", 503);
  return { revision: Number(rows[0].registration_revision), templateId: rows[0].template_id as string | null, approved: rows[0].approved_at != null };
}

async function registeredDevice(tx: Db, deviceId: string, updateLock = false): Promise<RegisteredDevice> {
  const { rows } = await tx.query(`
    SELECT device.site_id, device.public_key
      FROM kiosk_biometric_devices device
      JOIN access_sites site ON site.id = device.site_id AND site.active
     WHERE device.device_id = $1 AND device.active
     FOR ${updateLock ? "UPDATE" : "SHARE"} OF device, site
  `, [deviceId]);
  const row = rows[0];
  if (!row || typeof row.site_id !== "string" || typeof row.public_key !== "string") throw fail("INVALID_DEVICE_PROOF", 401);
  return { deviceId, siteId: row.site_id, publicKey: row.public_key };
}

function verifyDeviceSignature(device: RegisteredDevice, payload: string, signature: string): void {
  let valid = false;
  try {
    const key = createPublicKey({ key: Buffer.from(device.publicKey, "base64url"), format: "der", type: "spki" });
    const bytes = Buffer.from(signature, "base64url");
    valid = bytes.toString("base64url") === signature && key.asymmetricKeyType === "ec"
      && key.asymmetricKeyDetails?.namedCurve === "prime256v1"
      && verify("sha256", Buffer.from(payload, "utf8"), key, bytes);
  } catch {
    // Invalid keys and signatures intentionally share one response.
  }
  if (!valid) throw fail("INVALID_DEVICE_PROOF", 401);
}

function assertFresh(signed: RequestProof): void {
  const age = Date.now() - Date.parse(signed.issuedAt);
  if (age > 30_000 || age < -5_000) throw fail("INVALID_DEVICE_PROOF", 401);
}

async function consumeProof(tx: Db, deviceId: string, requestId: string): Promise<void> {
  const result = await tx.query(`INSERT INTO kiosk_biometric_requests(device_id, request_id) VALUES ($1,$2) ON CONFLICT DO NOTHING`, [deviceId, requestId]);
  if (result.rowCount !== 1) throw fail("REPLAYED_DEVICE_PROOF", 409);
}

function signedOperation(header: unknown, domain: string, device: RegisteredDevice, fields: string[]): RequestProof {
  const signed = proof(header);
  verifyDeviceSignature(device, signedRequest(domain, device.deviceId, signed, fields), signed.signature);
  assertFresh(signed);
  return signed;
}

async function activeAssignment(tx: Db, employeeId: string, siteId: string): Promise<boolean> {
  const { rows } = await tx.query(`
    SELECT employee.id
      FROM access_employees employee
      JOIN access_employee_sites assignment ON assignment.employee_id = employee.id AND assignment.active
      JOIN access_sites site ON site.id = assignment.site_id AND site.active
     WHERE employee.id = $1 AND employee.active AND assignment.site_id = $2
     FOR SHARE OF employee, assignment, site
  `, [employeeId, siteId]);
  return rows.length === 1;
}

async function limit(tx: Db, scope: string, subject: string, seconds: number, maximum: number, bump: boolean) {
  if (bump) {
    const { rows } = await tx.query(`
      WITH bucket AS (
        SELECT to_timestamp(floor(extract(epoch FROM clock_timestamp()) / $3) * $3) AS starts
      )
      INSERT INTO kiosk_face_enrollment_limits(scope,subject,bucket_start,hits)
      SELECT $1,$2,bucket.starts,1 FROM bucket
      ON CONFLICT (scope,subject,bucket_start) DO UPDATE SET hits = kiosk_face_enrollment_limits.hits + 1
      RETURNING hits,bucket_start,
        GREATEST(1,CEIL(EXTRACT(EPOCH FROM bucket_start + ($3 * INTERVAL '1 second') - clock_timestamp())))::integer AS wait_seconds
    `, [scope, subject, seconds]);
    const hits = Number(rows[0]?.hits ?? 0);
    return { allowed: hits <= maximum, waitSeconds: Number(rows[0]?.wait_seconds ?? 1) };
  }
  const { rows } = await tx.query(`
    SELECT hits, bucket_start,
           GREATEST(1,CEIL(EXTRACT(EPOCH FROM bucket_start + ($3 * INTERVAL '1 second') - clock_timestamp())))::integer AS wait_seconds
      FROM kiosk_face_enrollment_limits
     WHERE scope = $1 AND subject = $2
       AND bucket_start = to_timestamp(floor(extract(epoch FROM clock_timestamp()) / $3) * $3)
  `, [scope, subject, seconds]);
  const hits = Number(rows[0]?.hits ?? 0);
  return { allowed: hits < maximum, waitSeconds: Number(rows[0]?.wait_seconds ?? seconds) };
}

export async function getFaceEnrollmentStatus(
  tx: Db,
  input: { employeeId: string; actor?: Actor },
): Promise<FaceEnrollmentStatus> {
  const employeeId = uuid(input.employeeId);
  const assignments = await listActiveSiteAssignments(tx, employeeId);
  const employeeResult = await tx.query(`SELECT active, employee_code, display_name FROM access_employees WHERE id = $1`, [employeeId]);
  const activeEmployee = employeeResult.rows[0]?.active === true;
  const { rows: registrationRows } = await tx.query(`SELECT registration_revision, template_id, approved_at FROM kiosk_face_registrations WHERE employee_id = $1`, [employeeId]);
  const registrationRevision = registrationRows[0] ? Number(registrationRows[0].registration_revision) : 1;
  const registered = !!registrationRows[0]?.template_id;
  const approved = registrationRows[0]?.approved_at != null;
  const { rows: reregistration } = await tx.query(`SELECT 1 FROM kiosk_face_reregistration_requests WHERE employee_id = $1 AND resolved_at IS NULL`, [employeeId]);
  const { rows: codeRows } = await tx.query(`
    SELECT request_id,site_id,state,expires_at FROM kiosk_face_enrollment_requests
     WHERE employee_id = $1 AND state = 'issued' AND expires_at > clock_timestamp()
     ORDER BY issued_at DESC LIMIT 1
  `, [employeeId]);
  const notice = noticeConfig();
  let canReset = false;
  if (input.actor) {
    try {
      await authorizeFaceRegistrationReset(tx, { actor: input.actor, employeeId });
      canReset = true;
    } catch (error) {
      if (!(error instanceof AccessDeniedError)) throw error;
    }
  }
  return {
    registered,
    registrationRevision,
    registrationAvailable: !registered && approved && activeEmployee && assignments.length > 0 && notice !== null,
    eligibleSites: assignments,
    attendanceReadiness: { activeEmployee, activeSiteAssignmentCount: assignments.length },
    activeCodeRequest: codeRows[0] ? {
      requestId: String(codeRows[0].request_id), siteId: String(codeRows[0].site_id), state: "issued",
      expiresAt: iso(codeRows[0].expires_at),
    } : null,
    notice,
    canReset,
    employeeId,
    displayName: typeof employeeResult.rows[0]?.display_name === "string" ? employeeResult.rows[0].display_name : "",
    employeeCode: typeof employeeResult.rows[0]?.employee_code === "string" ? employeeResult.rows[0].employee_code : null,
    approvalPending: !registered && !approved,
    reregistrationRequested: reregistration.length > 0,
  };
}

export async function issueFaceEnrollmentCode(
  tx: Db,
  input: { employeeId: string; siteId: string; requestId: string; reissue: boolean },
): Promise<IssueEnrollmentResult> {
  const employeeId = uuid(input.employeeId);
  const siteId = uuid(input.siteId);
  const requestId = uuid(input.requestId);
  if (typeof input.reissue !== "boolean") throw fail("INVALID_ENROLLMENT_REQUEST");
  const notice = noticeConfig();
  if (!notice) throw fail("FACE_ENROLLMENT_NOTICE_UNAVAILABLE", 503);
  const payloadHash = hash(JSON.stringify([employeeId, siteId, input.reissue]));
  const key = digestKey();
  const registration = await lockRegistration(tx, employeeId);
  const existing = await tx.query(`SELECT employee_id,site_id,payload_hash,state,code_digest,expires_at,registration_revision FROM kiosk_face_enrollment_requests WHERE request_id = $1`, [requestId]);
  if (existing.rows[0]) {
    const row = existing.rows[0];
    if (String(row.employee_id) !== employeeId || String(row.site_id) !== siteId || row.payload_hash !== payloadHash || Number(row.registration_revision) !== registration.revision) throw fail("ENROLLMENT_REQUEST_CONFLICT", 409);
    return { state: "issued", requestId, siteId, code: null, expiresAt: iso(row.expires_at), recovered: true };
  }
  if (registration.templateId) throw fail("FACE_ALREADY_REGISTERED", 409);
  if (!registration.approved) throw fail("FACE_ENROLLMENT_APPROVAL_PENDING", 403);
  if (!await activeAssignment(tx, employeeId, siteId)) throw fail("FACE_ENROLLMENT_SITE_UNAVAILABLE", 403);
  const activeSession = await tx.query(`SELECT request_id FROM kiosk_face_enrollment_requests WHERE employee_id = $1 AND state = 'claimed' AND capture_expires_at > clock_timestamp() LIMIT 1`, [employeeId]);
  if (activeSession.rows.length) throw fail("ACTIVE_ENROLLMENT_SESSION_EXISTS", 409);
  const rate = await limit(tx, "issuance-hour", employeeId, 3600, 5, true);
  if (!rate.allowed) return { state: "rate_limited", waitSeconds: rate.waitSeconds };
  const current = await tx.query(`SELECT request_id FROM kiosk_face_enrollment_requests WHERE employee_id = $1 AND state = 'issued' AND expires_at > clock_timestamp() FOR UPDATE`, [employeeId]);
  if (current.rows.length && !input.reissue) throw fail("ACTIVE_ENROLLMENT_CODE_EXISTS", 409);
  if (input.reissue) await tx.query(`UPDATE kiosk_face_enrollment_requests SET state = 'superseded' WHERE employee_id = $1 AND state = 'issued'`, [employeeId]);

  for (let attempt = 0; attempt < 8; attempt++) {
    const code = generateEnrollmentCode();
    const codeDigest = siteScopedEnrollmentDigest(siteId, code, key);
    await tx.query(`SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`, [`${siteId}/${codeDigest}`]);
    await tx.query(`UPDATE kiosk_face_enrollment_requests SET state = 'expired' WHERE site_id = $1 AND code_digest = $2 AND state = 'issued' AND expires_at <= clock_timestamp()`, [siteId, codeDigest]);
    const { rows } = await tx.query(`
      INSERT INTO kiosk_face_enrollment_requests(request_id,employee_id,site_id,registration_revision,payload_hash,code_digest,state,expires_at)
      VALUES ($1,$2,$3,$4,$5,$6,'issued',clock_timestamp() + INTERVAL '5 minutes')
      ON CONFLICT (site_id,code_digest) WHERE state = 'issued' DO NOTHING
      RETURNING expires_at
    `, [requestId, employeeId, siteId, registration.revision, payloadHash, codeDigest]);
    if (rows[0]) return { state: "issued", requestId, siteId, code, expiresAt: iso(rows[0].expires_at), recovered: false };
  }
  throw fail("ENROLLMENT_CODE_UNAVAILABLE", 503);
}

function parseClaim(input: unknown): ClaimEnrollmentInput {
  const body = object(input, "deviceId", "requestId", "code");
  const code = body.code;
  if (typeof code !== "string" || !/^\d{6}$/.test(code)) throw fail("INVALID_KIOSK_REQUEST");
  return { deviceId: uuid(body.deviceId), requestId: uuid(body.requestId), code };
}

async function rejectedClaim(tx: Db, device: RegisteredDevice): Promise<ClaimEnrollmentResult> {
  const rate = await limit(tx, "claim-device-window", `${device.deviceId}/${device.siteId}`, 900, 8, true);
  return rate.allowed ? { state: "rejected", code: "KIOSK_ENROLLMENT_REJECTED" } : { state: "rate_limited", waitSeconds: rate.waitSeconds };
}

function shortName(name: unknown): string {
  return typeof name === "string" ? (name.trim().split(/\s+/)[0] ?? "") : "";
}

async function recoverClaim(
  tx: Db,
  row: Record<string, unknown>,
  request: ClaimEnrollmentInput,
  device: RegisteredDevice,
  requestDigest: string,
  notice: { version: string; text: string },
): Promise<ClaimEnrollmentResult> {
  const claimHash = hash(JSON.stringify([request.requestId, requestDigest, device.deviceId]));
  if (row.claimed_device_id !== device.deviceId || row.site_id !== device.siteId || row.code_digest !== requestDigest || row.claim_payload_hash !== claimHash) {
    return rejectedClaim(tx, device);
  }
  if (row.state !== "claimed" && row.state !== "completed") return rejectedClaim(tx, device);
  const details = await tx.query(`SELECT employee.display_name,site.name AS site_name FROM access_employees employee JOIN access_sites site ON site.id = $2 WHERE employee.id = $1`, [row.employee_id, device.siteId]);
  return { state: "claimed", sessionId: String(row.session_id), claimRequestId: request.requestId,
    employeeFirstName: shortName(details.rows[0]?.display_name), siteName: String(details.rows[0]?.site_name),
    registrationRevision: Number(row.registration_revision), notice, captureExpiresAt: iso(row.capture_expires_at) };
}

export async function claimFaceEnrollment(
  tx: Db,
  input: unknown,
  header: unknown,
): Promise<ClaimEnrollmentResult> {
  const request = parseClaim(input);
  const key = digestKey();
  const device = await registeredDevice(tx, request.deviceId);
  const signed = signedOperation(header, "elt-enrollment-claim-v1", device, [request.requestId, request.code]);
  const notice = noticeConfig();
  if (!notice) throw fail("FACE_ENROLLMENT_NOTICE_UNAVAILABLE", 503);
  const requestDigest = siteScopedEnrollmentDigest(device.siteId, request.code, key);
  const retry = await tx.query(`
    SELECT request_id,site_id,employee_id,registration_revision,state,code_digest,claim_payload_hash,claimed_device_id,
           session_id,capture_expires_at,claim_request_id
      FROM kiosk_face_enrollment_requests WHERE claim_request_id = $1
  `, [request.requestId]);
  if (retry.rows[0]) {
    await consumeProof(tx, device.deviceId, signed.requestId);
    return recoverClaim(tx, retry.rows[0], request, device, requestDigest, notice);
  }
  const throttle = await limit(tx, "claim-device-window", `${device.deviceId}/${device.siteId}`, 900, 8, false);
  if (!throttle.allowed) return { state: "rate_limited", waitSeconds: throttle.waitSeconds };
  const identity = await tx.query(`SELECT employee_id FROM kiosk_face_enrollment_requests WHERE site_id = $1 AND code_digest = $2 AND state = 'issued' AND expires_at > clock_timestamp()`, [device.siteId, requestDigest]);
  if (!identity.rows[0]) {
    await consumeProof(tx, device.deviceId, signed.requestId);
    return rejectedClaim(tx, device);
  }
  const employeeId = String(identity.rows[0].employee_id);
  const registration = await lockRegistration(tx, employeeId);
  const concurrentRetry = await tx.query(`
    SELECT request_id,site_id,employee_id,registration_revision,state,code_digest,claim_payload_hash,claimed_device_id,
           session_id,capture_expires_at,claim_request_id
      FROM kiosk_face_enrollment_requests WHERE claim_request_id = $1
  `, [request.requestId]);
  if (concurrentRetry.rows[0]) {
    await consumeProof(tx, device.deviceId, signed.requestId);
    return recoverClaim(tx, concurrentRetry.rows[0], request, device, requestDigest, notice);
  }
  const activeSession = await tx.query(`SELECT request_id FROM kiosk_face_enrollment_requests WHERE employee_id = $1 AND state = 'claimed' AND capture_expires_at > clock_timestamp() LIMIT 1`, [employeeId]);
  if (activeSession.rows.length) {
    await consumeProof(tx, device.deviceId, signed.requestId);
    return rejectedClaim(tx, device);
  }
  await consumeProof(tx, device.deviceId, signed.requestId);
  const rows = await tx.query(`
    SELECT enrollment.request_id,enrollment.employee_id,enrollment.registration_revision,enrollment.expires_at,
           employee.display_name,site.name AS site_name
      FROM kiosk_face_enrollment_requests enrollment
      JOIN access_employees employee ON employee.id = enrollment.employee_id AND employee.active
      JOIN access_sites site ON site.id = enrollment.site_id AND site.active
      JOIN access_employee_sites assignment ON assignment.employee_id = employee.id AND assignment.site_id = site.id AND assignment.active
     WHERE enrollment.site_id = $1 AND enrollment.code_digest = $2 AND enrollment.state = 'issued'
       AND enrollment.expires_at > clock_timestamp() AND enrollment.registration_revision = $3
     FOR UPDATE OF enrollment,employee,assignment,site
  `, [device.siteId, requestDigest, registration.revision]);
  if (!rows.rows[0] || registration.templateId) return rejectedClaim(tx, device);
  const sessionId = randomUUID();
  const claimHash = hash(JSON.stringify([request.requestId, requestDigest, device.deviceId]));
  const updated = await tx.query(`
    UPDATE kiosk_face_enrollment_requests
       SET state = 'claimed',claim_request_id = $2,claim_payload_hash = $3,claimed_device_id = $4,
           session_id = $5,capture_expires_at = clock_timestamp() + INTERVAL '5 minutes'
     WHERE request_id = $1 AND state = 'issued'
     RETURNING capture_expires_at
  `, [rows.rows[0].request_id, request.requestId, claimHash, device.deviceId, sessionId]);
  if (!updated.rows[0]) return rejectedClaim(tx, device);
  return { state: "claimed", sessionId, claimRequestId: request.requestId,
    employeeFirstName: shortName(rows.rows[0].display_name), siteName: String(rows.rows[0].site_name),
    registrationRevision: registration.revision, notice, captureExpiresAt: iso(updated.rows[0].capture_expires_at) };
}

function parseComplete(input: unknown): CompleteEnrollmentInput {
  const body = object(input, "deviceId", "claimRequestId", "sessionId", "requestId", "issuedAt", "consentVersion", "consented", "embedding", "frames", "integrityToken", "signature");
  if (body.consented !== true || typeof body.consentVersion !== "string" || body.consentVersion.length < 1 || body.consentVersion.length > 100) throw fail("INVALID_ENROLLMENT_CONSENT");
  if (typeof body.issuedAt !== "string" || !Number.isFinite(Date.parse(body.issuedAt)) || new Date(body.issuedAt).toISOString() !== body.issuedAt) throw fail("INVALID_KIOSK_REQUEST");
  const embedding = body.embedding;
  if (!Array.isArray(embedding) || embedding.length !== 128 || embedding.some(n => !Number.isInteger(n) || Math.abs(n as number) > 10000)
      || Math.abs(Math.hypot(...embedding as number[]) - 10000) > 10) throw fail("INVALID_KIOSK_REQUEST");
  const frames = body.frames;
  if (!Array.isArray(frames) || frames.length !== 3 || frames.some(frame => !Array.isArray(frame) || frame.length !== 4 || frame.some(n => !Number.isInteger(n) || (n as number) < 0 || (n as number) > 10000))) throw fail("INVALID_KIOSK_REQUEST");
  const integrityToken = body.integrityToken;
  if (typeof integrityToken !== "string" || !/^[A-Za-z0-9._=-]{64,16384}$/.test(integrityToken)) throw fail("INVALID_KIOSK_REQUEST");
  if (typeof body.signature !== "string" || !/^[A-Za-z0-9_-]{64,108}$/.test(body.signature)) throw fail("INVALID_KIOSK_REQUEST");
  return { deviceId: uuid(body.deviceId), claimRequestId: uuid(body.claimRequestId), sessionId: uuid(body.sessionId), requestId: uuid(body.requestId), issuedAt: body.issuedAt,
    consentVersion: body.consentVersion, consented: true, embedding: embedding as number[], frames: frames as Frame[], integrityToken, signature: body.signature };
}

function completionPayload(input: CompleteEnrollmentInput): string {
  return JSON.stringify(["elt-enrollment-complete-v1", input.deviceId, input.claimRequestId, input.sessionId, input.requestId,
    input.issuedAt, input.consentVersion, input.consented, input.embedding, input.frames]);
}

function checkCaptureSequence(frames: Frame[]): void {
  if (frames[0]![0] > 3500 || frames[2]![0] > 8500 || frames[1]![0] - frames[0]![0] < 250 || frames[2]![0] - frames[1]![0] < 250 || frames[2]![0] - frames[0]![0] < 650 || frames.some(frame => frame[1] < 9000)) {
    throw fail("BIOMETRIC_VERIFICATION_FAILED", 403);
  }
}

function encryptEmbedding(embedding: number[], identity: string): string {
  const text = process.env.KIOSK_TEMPLATE_KEY_HEX;
  if (!text || !/^[\da-f]{64}$/i.test(text)) throw fail("KIOSK_TEMPLATES_UNAVAILABLE", 503);
  const key = Buffer.from(text, "hex");
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(Buffer.from(identity, "utf8"));
  return Buffer.concat([iv, cipher.update(JSON.stringify(embedding)), cipher.final(), cipher.getAuthTag()]).toString("base64url");
}

function openEmbedding(value: string, identity: string): number[] {
  const text = process.env.KIOSK_TEMPLATE_KEY_HEX;
  if (!text || !/^[\da-f]{64}$/i.test(text)) throw fail("KIOSK_TEMPLATES_UNAVAILABLE", 503);
  try {
    const bytes = Buffer.from(value, "base64url");
    const decipher = createDecipheriv("aes-256-gcm", Buffer.from(text, "hex"), bytes.subarray(0, 12));
    decipher.setAAD(Buffer.from(identity, "utf8"));
    decipher.setAuthTag(bytes.subarray(-16));
    return JSON.parse(Buffer.concat([decipher.update(bytes.subarray(12, -16)), decipher.final()]).toString("utf8"));
  } catch {
    throw fail("KIOSK_TEMPLATES_UNAVAILABLE", 503);
  }
}

// ponytail: same score the kiosk accepts as a punch match, so any face the kiosk could confuse counts as a duplicate. Calibration knob.
export const DUPLICATE_FACE_SIMILARITY = 0.5;

/**
 * First name of another active employee whose registered face matches [embedding] (unit vector scaled to 10000), else null.
 * ponytail: decrypts every active template per enrollment, O(employees); fine for one company, index embeddings past ~10k.
 */
export async function findRegisteredFace(tx: { query(sql: string, values?: unknown[]): Promise<{ rows: Record<string, unknown>[] }> }, embedding: number[], employeeId: string): Promise<string | null> {
  const { rows } = await tx.query(`
    SELECT template.template_id, template.site_id, template.employee_id, template.sealed_embedding, employee.display_name
      FROM kiosk_face_templates template
      JOIN access_employees employee ON employee.id = template.employee_id AND employee.active
     WHERE template.retired_at IS NULL AND template.employee_id <> $1
  `, [employeeId]);
  for (const row of rows) {
    const other = openEmbedding(String(row.sealed_embedding), `${row.site_id}/${row.employee_id}/${row.template_id}`);
    const score = embedding.reduce((sum, value, index) => sum + value * (other[index] ?? 0), 0) / 1e8;
    if (score >= DUPLICATE_FACE_SIMILARITY) return shortName(row.display_name) || "A colleague";
  }
  return null;
}

export async function completeFaceEnrollment(tx: Db, input: unknown): Promise<{ state: "completed"; completedAt: string } | { state: "duplicate"; registeredName: string }> {
  const request = parseComplete(input);
  const device = await registeredDevice(tx, request.deviceId);
  const payload = completionPayload(request);
  verifyDeviceSignature(device, signedIntegrityPayload(payload, request.integrityToken), request.signature);
  const signed: RequestProof = { requestId: request.requestId, issuedAt: request.issuedAt, signature: request.signature };
  assertFresh(signed);
  checkCaptureSequence(request.frames);
  const payloadHash = hash(JSON.stringify([payload, request.integrityToken]));
  const identity = await tx.query(`SELECT employee_id FROM kiosk_face_enrollment_requests WHERE claim_request_id = $1 AND session_id = $2`, [request.claimRequestId, request.sessionId]);
  if (!identity.rows[0]) throw fail("KIOSK_ENROLLMENT_REJECTED", 403);
  const employeeId = String(identity.rows[0].employee_id);
  const registration = await lockRegistration(tx, employeeId);
  const { rows } = await tx.query(`
    SELECT enrollment.request_id,enrollment.site_id,enrollment.registration_revision,enrollment.state,enrollment.claimed_device_id,
           enrollment.capture_expires_at,enrollment.completion_request_id,enrollment.completion_payload_hash,enrollment.completed_at
      FROM kiosk_face_enrollment_requests enrollment
     WHERE enrollment.claim_request_id = $1 AND enrollment.session_id = $2
     FOR UPDATE
  `, [request.claimRequestId, request.sessionId]);
  const session = rows[0];
  if (!session || session.claimed_device_id !== device.deviceId || session.site_id !== device.siteId) throw fail("KIOSK_ENROLLMENT_REJECTED", 403);
  if (session.state === "completed") {
    if (session.completion_request_id !== request.requestId || session.completion_payload_hash !== payloadHash) throw fail("KIOSK_ENROLLMENT_REJECTED", 403);
    return { state: "completed", completedAt: iso(session.completed_at) };
  }
  if (session.state !== "claimed" || Number(session.registration_revision) !== registration.revision || registration.templateId) throw fail("KIOSK_ENROLLMENT_REJECTED", 403);
  const expiry = await tx.query(`SELECT clock_timestamp() < $1::timestamptz AS live`, [session.capture_expires_at]);
  if (expiry.rows[0]?.live !== true) throw fail("KIOSK_ENROLLMENT_REJECTED", 403);
  const notice = noticeConfig();
  if (!notice || request.consentVersion !== notice.version) throw fail("INVALID_ENROLLMENT_CONSENT", 400);
  if (!await activeAssignment(tx, employeeId, device.siteId)) throw fail("KIOSK_ENROLLMENT_REJECTED", 403);
  await consumeProof(tx, device.deviceId, request.requestId);
  await verifyPlayIntegrity(request.integrityToken, payload, Date.parse(request.issuedAt) - 5_000);
  const registeredName = await findRegisteredFace(tx, request.embedding, employeeId);
  if (registeredName) {
    // Commit the cancellation so this capture can never be retried; the claimed code is spent.
    await tx.query(`UPDATE kiosk_face_enrollment_requests SET state = 'cancelled' WHERE request_id = $1 AND state = 'claimed'`, [session.request_id]);
    return { state: "duplicate", registeredName };
  }
  const templateId = randomUUID();
  const identityText = `${device.siteId}/${employeeId}/${templateId}`;
  const inserted = await tx.query(`
    INSERT INTO kiosk_face_templates(template_id,site_id,employee_id,sealed_embedding)
    VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING RETURNING template_id
  `, [templateId, device.siteId, employeeId, encryptEmbedding(request.embedding, identityText)]);
  if (inserted.rowCount !== 1) throw fail("FACE_ALREADY_REGISTERED", 409);
  const linked = await tx.query(`
    UPDATE kiosk_face_registrations SET template_id = $2,registered_at = clock_timestamp(),updated_at = clock_timestamp()
     WHERE employee_id = $1 AND registration_revision = $3 AND template_id IS NULL
  `, [employeeId, templateId, registration.revision]);
  if (linked.rowCount !== 1) throw fail("FACE_REGISTRATION_CONFLICT", 409);
  const completed = await tx.query(`
    UPDATE kiosk_face_enrollment_requests
       SET state = 'completed',completion_request_id = $2,completion_payload_hash = $3,completed_at = clock_timestamp()
     WHERE request_id = $1 AND state = 'claimed' RETURNING completed_at
  `, [session.request_id, request.requestId, payloadHash]);
  if (!completed.rows[0]) throw fail("KIOSK_ENROLLMENT_REJECTED", 403);
  return { state: "completed", completedAt: iso(completed.rows[0].completed_at) };
}

function parseStatus(input: unknown) {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw fail("INVALID_KIOSK_REQUEST");
  const keys = Object.keys(input);
  if (keys.some(key => !["deviceId", "claimRequestId", "sessionId"].includes(key))
      || !Object.hasOwn(input, "deviceId") || !Object.hasOwn(input, "claimRequestId")) throw fail("INVALID_KIOSK_REQUEST");
  const body = input as Record<string, unknown>;
  return { deviceId: uuid(body.deviceId), claimRequestId: uuid(body.claimRequestId), sessionId: body.sessionId === null || body.sessionId === undefined ? null : uuid(body.sessionId) };
}

export async function getFaceEnrollmentSessionStatus(tx: Db, input: unknown, header: unknown): Promise<EnrollmentSessionStatus> {
  const request = parseStatus(input);
  const device = await registeredDevice(tx, request.deviceId);
  const signed = signedOperation(header, "elt-enrollment-status-v1", device, [request.claimRequestId, request.sessionId ?? ""]);
  await consumeProof(tx, device.deviceId, signed.requestId);
  const { rows } = await tx.query(`
    SELECT enrollment.state,enrollment.session_id,enrollment.capture_expires_at,enrollment.expires_at,enrollment.completed_at,
           enrollment.claimed_device_id,enrollment.site_id,employee.display_name,site.name AS site_name,
           (enrollment.state = 'issued' AND enrollment.expires_at <= clock_timestamp())
             OR (enrollment.state = 'claimed' AND enrollment.capture_expires_at <= clock_timestamp()) AS is_expired
      FROM kiosk_face_enrollment_requests enrollment
      LEFT JOIN access_employees employee ON employee.id = enrollment.employee_id
      LEFT JOIN access_sites site ON site.id = enrollment.site_id
     WHERE enrollment.claim_request_id = $1
  `, [request.claimRequestId]);
  const row = rows[0];
  if (!row || (request.sessionId && row.session_id !== request.sessionId)) return { state: "not_found", claimRequestId: request.claimRequestId };
  const state = row.is_expired ? "expired" : row.state as State;
  const bound = row.claimed_device_id === device.deviceId && device.siteId === row.site_id;
  if (!bound) return { state, claimRequestId: request.claimRequestId };
  return { state, claimRequestId: request.claimRequestId,
    ...(row.session_id ? { sessionId: String(row.session_id) } : {}),
    ...(row.display_name && row.site_name ? { employeeFirstName: shortName(row.display_name), siteName: String(row.site_name) } : {}),
    ...(row.completed_at ? { completedAt: iso(row.completed_at) } : {}) };
}

function parseCancel(input: unknown) {
  const body = object(input, "deviceId", "claimRequestId", "sessionId");
  return { deviceId: uuid(body.deviceId), claimRequestId: uuid(body.claimRequestId), sessionId: uuid(body.sessionId) };
}

export async function cancelFaceEnrollment(tx: Db, input: unknown, header: unknown): Promise<{ state: "cancelled" | "completed" | "not_found" }> {
  const request = parseCancel(input);
  const device = await registeredDevice(tx, request.deviceId);
  const signed = signedOperation(header, "elt-enrollment-cancel-v1", device, [request.claimRequestId, request.sessionId]);
  const identity = await tx.query(`SELECT employee_id FROM kiosk_face_enrollment_requests WHERE claim_request_id = $1 AND session_id = $2`, [request.claimRequestId, request.sessionId]);
  if (!identity.rows[0]) return { state: "not_found" };
  const employeeId = String(identity.rows[0].employee_id);
  const registration = await lockRegistration(tx, employeeId);
  const { rows } = await tx.query(`SELECT state,claimed_device_id,site_id,registration_revision FROM kiosk_face_enrollment_requests WHERE claim_request_id = $1 AND session_id = $2 FOR UPDATE`, [request.claimRequestId, request.sessionId]);
  const row = rows[0];
  if (!row || row.claimed_device_id !== device.deviceId || row.site_id !== device.siteId) return { state: "not_found" };
  await consumeProof(tx, device.deviceId, signed.requestId);
  if (Number(row.registration_revision) !== registration.revision) return { state: "cancelled" };
  if (row.state === "completed") return { state: "completed" };
  if (row.state === "claimed") {
    await tx.query(`UPDATE kiosk_face_enrollment_requests SET state = 'cancelled' WHERE claim_request_id = $1 AND state = 'claimed'`, [request.claimRequestId]);
  }
  return { state: "cancelled" };
}

export async function resetFaceRegistration(
  tx: Db,
  input: ResetFaceRegistrationInput,
  actor: Actor,
): Promise<{ employeeId: string; oldRevision: number; registrationRevision: number; resetAt: string; recovered: boolean }> {
  const employeeId = uuid(input.employeeId);
  const requestId = uuid(input.requestId);
  if (typeof input.reason !== "string" || input.reason.trim().length < 1 || input.reason.trim().length > 1000) throw fail("INVALID_RESET_REASON");
  await authorizeFaceRegistrationReset(tx, { actor, employeeId });
  const payloadHash = hash(JSON.stringify([employeeId, input.reason]));
  const registration = await lockRegistration(tx, employeeId);
  const replay = await tx.query(`SELECT actor_employee_id,payload_hash,old_revision,new_revision,created_at FROM kiosk_face_registration_resets WHERE request_id = $1`, [requestId]);
  if (replay.rows[0]) {
    const row = replay.rows[0];
    if (row.actor_employee_id !== actor.employeeId || row.payload_hash !== payloadHash) throw fail("RESET_REQUEST_CONFLICT", 409);
    return { employeeId, oldRevision: Number(row.old_revision), registrationRevision: Number(row.new_revision), resetAt: iso(row.created_at), recovered: true };
  }
  await tx.query(`UPDATE kiosk_face_templates SET retired_at = clock_timestamp() WHERE employee_id = $1 AND retired_at IS NULL`, [employeeId]);
  await tx.query(`DELETE FROM kiosk_face_enrollment_codes WHERE employee_id = $1`, [employeeId]);
  await tx.query(`UPDATE kiosk_face_reregistration_requests SET resolved_at = clock_timestamp() WHERE employee_id = $1 AND resolved_at IS NULL`, [employeeId]);
  await tx.query(`UPDATE kiosk_face_enrollment_requests SET state = 'cancelled' WHERE employee_id = $1 AND state IN ('issued','claimed')`, [employeeId]);
  const updated = await tx.query(`
    UPDATE kiosk_face_registrations
       SET template_id = NULL,registered_at = NULL,registration_revision = registration_revision + 1,updated_at = clock_timestamp()
     WHERE employee_id = $1 AND registration_revision = $2
     RETURNING registration_revision,updated_at
  `, [employeeId, registration.revision]);
  if (!updated.rows[0]) throw fail("FACE_REGISTRATION_CONFLICT", 409);
  await tx.query(`
    INSERT INTO kiosk_face_registration_resets(request_id,employee_id,actor_employee_id,reason,old_revision,new_revision,payload_hash)
    VALUES ($1,$2,$3,$4,$5,$6,$7)
  `, [requestId, employeeId, actor.employeeId, input.reason.trim(), registration.revision, Number(updated.rows[0].registration_revision), payloadHash]);
  return { employeeId, oldRevision: registration.revision, registrationRevision: Number(updated.rows[0].registration_revision), resetAt: iso(updated.rows[0].updated_at), recovered: false };
}

/** HR/ADMIN approval that lets a signed-up employee issue a self-service enrollment code. Idempotent. */
export async function approveFaceEnrollment(tx: Db, input: { employeeId: string }, actor: Actor): Promise<{ employeeId: string; approved: true }> {
  const employeeId = uuid(input.employeeId);
  await authorizeFaceRegistrationReset(tx, { actor, employeeId });
  await lockRegistration(tx, employeeId);
  await tx.query(`UPDATE kiosk_face_registrations SET approved_at = coalesce(approved_at, clock_timestamp()), updated_at = clock_timestamp() WHERE employee_id = $1`, [employeeId]);
  return { employeeId, approved: true };
}

/** An employee's own request for HR to reset their face (Settings, Biometric issues). One open request per employee. */
export async function requestFaceReregistration(
  tx: Db,
  input: { employeeId: string; requestId: string; reason: unknown },
): Promise<{ requestId: string; state: "open" }> {
  const employeeId = uuid(input.employeeId);
  const requestId = uuid(input.requestId);
  if (typeof input.reason !== "string" || input.reason.trim().length < 1 || input.reason.trim().length > 1000) throw fail("INVALID_REREGISTRATION_REASON");
  const registration = await lockRegistration(tx, employeeId);
  if (!registration.templateId) throw fail("FACE_NOT_REGISTERED", 409);
  const open = await tx.query(`SELECT request_id FROM kiosk_face_reregistration_requests WHERE employee_id = $1 AND resolved_at IS NULL`, [employeeId]);
  if (open.rows[0]) return { requestId: String(open.rows[0].request_id), state: "open" };
  await tx.query(`INSERT INTO kiosk_face_reregistration_requests(request_id, employee_id, reason) VALUES ($1, $2, $3)`, [requestId, employeeId, input.reason.trim()]);
  return { requestId, state: "open" };
}

/** HR work queue: employees awaiting enrollment approval and open re-registration requests. */
export async function listFaceEnrollmentQueue(tx: Db, actor: Actor) {
  await authorizeHrOperator(tx, actor);
  const pending = await tx.query(`
    SELECT employee.id, employee.employee_code, employee.display_name
      FROM access_employees employee
      LEFT JOIN kiosk_face_registrations registration ON registration.employee_id = employee.id
     WHERE employee.active AND registration.approved_at IS NULL AND registration.template_id IS NULL
     ORDER BY employee.employee_code LIMIT 200
  `);
  const requests = await tx.query(`
    SELECT request.request_id, employee.id, employee.employee_code, employee.display_name, request.reason, request.created_at
      FROM kiosk_face_reregistration_requests request
      JOIN access_employees employee ON employee.id = request.employee_id
     WHERE request.resolved_at IS NULL
     ORDER BY request.created_at LIMIT 200
  `);
  const person = (row: Record<string, unknown>) => ({ employeeId: String(row.id), employeeCode: String(row.employee_code), displayName: String(row.display_name) });
  return {
    pendingApprovals: pending.rows.map(person),
    reregistrationRequests: requests.rows.map(row => ({ ...person(row), requestId: String(row.request_id), reason: String(row.reason), createdAt: iso(row.created_at) })),
  };
}
