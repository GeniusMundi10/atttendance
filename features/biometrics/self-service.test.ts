// PURPOSE: Verify self-service enrollment protocol behavior without real identities or production secrets.
import assert from "node:assert/strict";
import { createCipheriv, generateKeyPairSync, randomBytes, randomUUID, sign } from "node:crypto";
import { test } from "node:test";
import {
  BiometricsError, claimFaceEnrollment, completeFaceEnrollment, generateEnrollmentCode, getFaceEnrollmentStatus,
  issueFaceEnrollmentCode, resetFaceRegistration, siteScopedEnrollmentDigest,
} from "./server.ts";
import { hash, signedIntegrityPayload, signedRequest } from "./protocol.ts";

type QueryClient = Parameters<typeof getFaceEnrollmentStatus>[0];
const key = "a1".repeat(32);
const failure = (code: string) => (error: unknown) => error instanceof BiometricsError && error.code === code;
const env = (values: Record<string, string | undefined>, fn: () => Promise<void>) => async () => {
  const previous = Object.fromEntries(Object.keys(values).map(name => [name, process.env[name]]));
  for (const [name, value] of Object.entries(values)) value === undefined ? delete process.env[name] : process.env[name] = value;
  try { await fn(); } finally { for (const [name, value] of Object.entries(previous)) value === undefined ? delete process.env[name] : process.env[name] = value; }
};

test("code generation preserves six decimal characters and site-scoped HMACs differ by site", () => {
  const values = Array.from({ length: 1024 }, generateEnrollmentCode);
  assert.ok(values.every(value => /^\d{6}$/.test(value)));
  assert.ok(values.some(value => value.startsWith("0")));
  const code = "005194";
  assert.notEqual(siteScopedEnrollmentDigest(randomUUID(), code, Buffer.from(key, "hex")), siteScopedEnrollmentDigest(randomUUID(), code, Buffer.from(key, "hex")));
});

test("portal status reports active assignments and registration readiness separately", async () => {
  const employeeId = randomUUID();
  const siteId = randomUUID();
  const client = {
    async query(sql: string) {
      if (sql.includes("SELECT s.id AS site_id")) return { rows: [{ site_id: siteId, site_name: "Synthetic Site" }] };
      if (sql.includes("SELECT active, employee_code, display_name FROM access_employees")) return { rows: [{ active: true, employee_code: "ELT00007", display_name: "Synthetic Worker" }] };
      if (sql.includes("FROM kiosk_face_registrations")) return { rows: [{ registration_revision: 4, template_id: null, approved_at: null }] };
      if (sql.includes("FROM kiosk_face_reregistration_requests")) return { rows: [] };
      if (sql.includes("FROM kiosk_face_enrollment_requests") && sql.includes("state = 'issued'")) return { rows: [] };
      throw new Error("Unexpected status query");
    },
  } as unknown as QueryClient;
  const status = await getFaceEnrollmentStatus(client, { employeeId });
  assert.equal(status.registrationRevision, 4);
  assert.equal(status.registered, false);
  assert.deepEqual(status.eligibleSites, [{ siteId, siteName: "Synthetic Site" }]);
  assert.deepEqual(status.attendanceReadiness, { activeEmployee: true, activeSiteAssignmentCount: 1 });
  assert.equal(status.employeeCode, "ELT00007");
  assert.equal(status.displayName, "Synthetic Worker");
  assert.equal(status.employeeId, employeeId);
  // Not yet approved by HR: pending, and no code can be issued.
  assert.equal(status.approvalPending, true);
  assert.equal(status.registrationAvailable, false);
  assert.equal(status.reregistrationRequested, false);
});

test("issuance returns plaintext once, persists only its site-bound digest, and recovers employee-bound idempotently", env({
  KIOSK_ENROLLMENT_CODE_KEY_HEX: key,
  KIOSK_FACE_ENROLLMENT_NOTICE_VERSION: "notice-v1",
  KIOSK_FACE_ENROLLMENT_NOTICE_TEXT: "Synthetic approved notice",
}, async () => {
  const employeeId = randomUUID();
  const siteId = randomUUID();
  const requestId = randomUUID();
  const persisted: unknown[][] = [];
  let recover = false;
  let approved = false;
  const client = {
    async query(sql: string, values: unknown[] = []) {
      if (sql.includes("INSERT INTO kiosk_face_registrations")) return { rows: [], rowCount: 1 };
      if (sql.includes("SELECT registration_revision, template_id")) return { rows: [{ registration_revision: 2, template_id: null, approved_at: approved ? new Date() : null }], rowCount: 1 };
      if (sql.includes("SELECT employee_id,site_id,payload_hash,state,code_digest,expires_at")) return { rows: recover ? [{ employee_id: employeeId, site_id: siteId, payload_hash: values[0] === requestId ? (persisted[0]?.[4] ?? "") : "", state: "issued", code_digest: "not-returned", expires_at: new Date(Date.now() + 60_000), registration_revision: 2 }] : [], rowCount: recover ? 1 : 0 };
      if (sql.includes("FROM access_employees employee") && sql.includes("FOR SHARE")) return { rows: [{ id: employeeId }], rowCount: 1 };
      if (sql.includes("state = 'claimed' AND capture_expires_at")) return { rows: [], rowCount: 0 };
      if (sql.includes("INSERT INTO kiosk_face_enrollment_limits")) return { rows: [{ hits: 1, bucket_start: new Date() }], rowCount: 1 };
      if (sql.includes("pg_advisory_xact_lock")) return { rows: [{ pg_advisory_xact_lock: null }], rowCount: 1 };
      if (sql.includes("UPDATE kiosk_face_enrollment_requests SET state = 'expired'")) return { rows: [], rowCount: 0 };
      if (sql.includes("SELECT request_id FROM kiosk_face_enrollment_requests WHERE employee_id")) return { rows: [], rowCount: 0 };
      if (sql.includes("INSERT INTO kiosk_face_enrollment_requests")) {
        persisted.push(values);
        return { rows: [{ expires_at: new Date(Date.now() + 300_000) }], rowCount: 1 };
      }
      throw new Error(`Unexpected issuance query ${sql.slice(0, 80)}`);
    },
  } as unknown as QueryClient;
  const input = { employeeId, siteId, requestId, reissue: false };
  await assert.rejects(issueFaceEnrollmentCode(client, input), failure("FACE_ENROLLMENT_APPROVAL_PENDING"));
  approved = true;
  const issued = await issueFaceEnrollmentCode(client, input);
  assert.equal(issued.state, "issued");
  if (issued.state !== "issued") throw new Error("Expected issued state");
  assert.match(issued.code ?? "", /^\d{6}$/);
  assert.equal(persisted[0]?.[5], siteScopedEnrollmentDigest(siteId, issued.code!, Buffer.from(key, "hex")));
  assert.equal(issued.recovered, false);
  recover = true;
  const recovered = await issueFaceEnrollmentCode(client, input);
  assert.equal(recovered.state, "issued");
  if (recovered.state !== "issued") throw new Error("Expected issued recovery");
  assert.equal(recovered.code, null);
  assert.equal(recovered.recovered, true);
  await assert.rejects(issueFaceEnrollmentCode(client, { ...input, employeeId: randomUUID() }), failure("ENROLLMENT_REQUEST_CONFLICT"));
}));

test("claim requires a P-256 signature and recovers the same session on a fresh same-kiosk retry", env({
  KIOSK_ENROLLMENT_CODE_KEY_HEX: key,
  KIOSK_FACE_ENROLLMENT_NOTICE_VERSION: "notice-v1",
  KIOSK_FACE_ENROLLMENT_NOTICE_TEXT: "Synthetic approved notice",
}, async () => {
  const deviceId = randomUUID();
  const siteId = randomUUID();
  const employeeId = randomUUID();
  const requestId = randomUUID();
  const code = "001237";
  const { publicKey, privateKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const publicText = publicKey.export({ format: "der", type: "spki" }).toString("base64url");
  const issuedAt = new Date().toISOString();
  const proof = { requestId: randomUUID(), issuedAt, signature: "" };
  proof.signature = sign("sha256", Buffer.from(signedRequest("elt-enrollment-claim-v1", deviceId, proof, [requestId, code])), privateKey).toString("base64url");
  let didConsume = false;
  const consumedProofs = new Set<string>();
  const enrollmentRequestId = randomUUID();
  let savedClaim: Record<string, unknown> | null = null;
  const client = {
    async query(sql: string, values: unknown[] = []) {
      if (sql.includes("FROM kiosk_biometric_devices")) return { rows: [{ site_id: siteId, public_key: publicText }], rowCount: 1 };
      if (sql.includes("WHERE claim_request_id = $1")) return { rows: savedClaim ? [savedClaim] : [], rowCount: savedClaim ? 1 : 0 };
      if (sql.includes("SELECT employee.display_name,site.name AS site_name")) return { rows: [{ display_name: "Synthetic Worker", site_name: "Synthetic Site" }], rowCount: 1 };
      if (sql.includes("FROM kiosk_face_enrollment_limits")) return { rows: [], rowCount: 0 };
      if (sql.includes("SELECT employee_id FROM kiosk_face_enrollment_requests WHERE site_id")) return { rows: [{ employee_id: employeeId }], rowCount: 1 };
      if (sql.includes("INSERT INTO kiosk_face_registrations")) return { rows: [], rowCount: 1 };
      if (sql.includes("SELECT registration_revision, template_id")) return { rows: [{ registration_revision: 1, template_id: null }], rowCount: 1 };
      if (sql.includes("INSERT INTO kiosk_biometric_requests")) { didConsume = true; consumedProofs.add(String(values[1])); return { rows: [], rowCount: 1 }; }
      if (sql.includes("state = 'claimed' AND capture_expires_at")) return { rows: [], rowCount: 0 };
      if (sql.includes("FROM kiosk_face_enrollment_requests enrollment")) return { rows: [{ request_id: enrollmentRequestId, employee_id: employeeId, registration_revision: 1, expires_at: new Date(Date.now() + 30_000), display_name: "Synthetic Worker", site_name: "Synthetic Site" }], rowCount: 1 };
      if (sql.includes("UPDATE kiosk_face_enrollment_requests")) {
        const captureExpiresAt = new Date(Date.now() + 300_000);
        savedClaim = { request_id: enrollmentRequestId, site_id: siteId, employee_id: employeeId, registration_revision: 1,
          state: "claimed", code_digest: siteScopedEnrollmentDigest(siteId, code, Buffer.from(key, "hex")),
          claim_payload_hash: values[2], claimed_device_id: deviceId, session_id: values[4], capture_expires_at: captureExpiresAt,
          claim_request_id: requestId };
        return { rows: [{ capture_expires_at: captureExpiresAt }], rowCount: 1 };
      }
      throw new Error(`Unexpected claim query ${sql.slice(0, 100)}`);
    },
  } as unknown as QueryClient;
  const result = await claimFaceEnrollment(client, { deviceId, requestId, code }, proof);
  assert.equal(result.state, "claimed");
  if (result.state !== "claimed") throw new Error("Expected claim success");
  assert.equal(result.employeeFirstName, "Synthetic");
  assert.equal(result.siteName, "Synthetic Site");
  assert.equal(didConsume, true);
  const recoveryProof = { requestId: randomUUID(), issuedAt: new Date().toISOString(), signature: "" };
  recoveryProof.signature = sign("sha256", Buffer.from(signedRequest("elt-enrollment-claim-v1", deviceId, recoveryProof, [requestId, code])), privateKey).toString("base64url");
  const recovered = await claimFaceEnrollment(client, { deviceId, requestId, code }, recoveryProof);
  assert.deepEqual(recovered, result);
  assert.equal(consumedProofs.size, 2);
  await assert.rejects(claimFaceEnrollment(client, { deviceId, requestId, code: "001238" }, proof), failure("INVALID_DEVICE_PROOF"));
}));

test("completion verifies consent and integrity, writes one encrypted template, and recovers a committed retry without attendance side effects", async t => {
  const previous = Object.fromEntries(["KIOSK_TEMPLATE_KEY_HEX", "KIOSK_PLAY_CERT_SHA256", "KIOSK_PLAY_SERVICE_ACCOUNT_JSON", "KIOSK_FACE_ENROLLMENT_NOTICE_VERSION", "KIOSK_FACE_ENROLLMENT_NOTICE_TEXT"]
    .map(name => [name, process.env[name]]));
  const deviceId = randomUUID();
  const siteId = randomUUID();
  const employeeId = randomUUID();
  const claimRequestId = randomUUID();
  const sessionId = randomUUID();
  const requestId = randomUUID();
  const { publicKey, privateKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const service = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const cert = randomBytes(32).toString("hex");
  process.env.KIOSK_TEMPLATE_KEY_HEX = randomBytes(32).toString("hex");
  process.env.KIOSK_PLAY_CERT_SHA256 = cert;
  process.env.KIOSK_PLAY_SERVICE_ACCOUNT_JSON = JSON.stringify({ client_email: "synthetic@example.invalid", private_key: service.privateKey.export({ format: "pem", type: "pkcs8" }).toString() });
  process.env.KIOSK_FACE_ENROLLMENT_NOTICE_VERSION = "notice-v1";
  process.env.KIOSK_FACE_ENROLLMENT_NOTICE_TEXT = "Synthetic approved notice";
  const payloads = new Map<string, string>();
  t.mock.method(globalThis, "fetch", async (target: RequestInfo | URL, options?: RequestInit) => {
    const url = String(target);
    if (url === "https://oauth2.googleapis.com/token") return Response.json({ access_token: "synthetic-integrity-session", expires_in: 3600 });
    if (url === "https://playintegrity.googleapis.com/v1/com.elt.attendance.kiosk:decodeIntegrityToken") {
      const token = JSON.parse(String(options?.body)).integrity_token as string;
      const payload = payloads.get(token);
      if (!payload) return new Response(null, { status: 400 });
      return Response.json({ tokenPayloadExternal: {
        requestDetails: { requestPackageName: "com.elt.attendance.kiosk", requestHash: hash(payload), timestampMillis: String(Date.now()) },
        appIntegrity: { appRecognitionVerdict: "PLAY_RECOGNIZED", packageName: "com.elt.attendance.kiosk", certificateSha256Digest: [Buffer.from(cert, "hex").toString("base64url")] },
        deviceIntegrity: { deviceRecognitionVerdict: ["MEETS_STRONG_INTEGRITY"] },
      } });
    }
    return new Response(null, { status: 404 });
  });
  try {
    const issuedAt = new Date().toISOString();
    const embedding = [10000, ...Array(127).fill(0)];
    const frames = [[0, 9900, 0, 0], [350, 9900, 0, 0], [700, 9900, 0, 0]];
    const integrityToken = randomBytes(64).toString("base64url");
    const payload = JSON.stringify(["elt-enrollment-complete-v1", deviceId, claimRequestId, sessionId, requestId, issuedAt, "notice-v1", true, embedding, frames]);
    payloads.set(integrityToken, payload);
    const input = { deviceId, claimRequestId, sessionId, requestId, issuedAt, consentVersion: "notice-v1", consented: true as const,
      embedding, frames, integrityToken,
      signature: sign("sha256", Buffer.from(signedIntegrityPayload(payload, integrityToken)), privateKey).toString("base64url") };
    let state = "claimed";
    let completedAt: Date | null = null;
    let completionRequestId: string | null = null;
    let completionPayloadHash: string | null = null;
    let registrationTemplate: string | null = null;
    let storedEmbedding = "";
    let templateWrites = 0;
    let attendanceQueries = 0;
    let others: Record<string, unknown>[] = [];
    let cancelled = false;
    const client = {
      async query(sql: string, values: unknown[] = []) {
        if (sql.includes("attendance_")) { attendanceQueries++; throw new Error("Enrollment must not call attendance storage"); }
        if (sql.includes("FROM kiosk_face_templates template")) return { rows: others, rowCount: others.length };
        if (sql.includes("SET state = 'cancelled'")) { cancelled = true; return { rows: [], rowCount: 1 }; }
        if (sql.includes("FROM kiosk_biometric_devices")) return { rows: [{ site_id: siteId, public_key: publicKey.export({ format: "der", type: "spki" }).toString("base64url") }], rowCount: 1 };
        if (sql.includes("SELECT employee_id FROM kiosk_face_enrollment_requests WHERE claim_request_id")) return { rows: [{ employee_id: employeeId }], rowCount: 1 };
        if (sql.includes("INSERT INTO kiosk_face_registrations")) return { rows: [], rowCount: 1 };
        if (sql.includes("SELECT registration_revision, template_id")) return { rows: [{ registration_revision: 1, template_id: registrationTemplate }], rowCount: 1 };
        if (sql.includes("FROM kiosk_face_enrollment_requests enrollment")) return { rows: [{ request_id: randomUUID(), site_id: siteId,
          registration_revision: 1, state, claimed_device_id: deviceId, capture_expires_at: new Date(Date.now() + 300_000),
          completion_request_id: completionRequestId, completion_payload_hash: completionPayloadHash, completed_at: completedAt }], rowCount: 1 };
        if (sql.includes("clock_timestamp() < $1::timestamptz")) return { rows: [{ live: true }], rowCount: 1 };
        if (sql.includes("FROM access_employees employee")) return { rows: [{ id: employeeId }], rowCount: 1 };
        if (sql.includes("INSERT INTO kiosk_biometric_requests")) return { rows: [], rowCount: 1 };
        if (sql.includes("INSERT INTO kiosk_face_templates")) { templateWrites++; storedEmbedding = String(values[3]); return { rows: [{ template_id: values[0] }], rowCount: 1 }; }
        if (sql.includes("UPDATE kiosk_face_registrations SET template_id")) { registrationTemplate = String(values[1]); return { rows: [], rowCount: 1 }; }
        if (sql.includes("UPDATE kiosk_face_enrollment_requests")) {
          state = "completed";
          completionRequestId = String(values[1]);
          completionPayloadHash = String(values[2]);
          completedAt = new Date();
          return { rows: [{ completed_at: completedAt }], rowCount: 1 };
        }
        throw new Error(`Unexpected completion query ${sql.slice(0, 100)}`);
      },
    } as unknown as QueryClient;

    await assert.rejects(completeFaceEnrollment(client, { ...input, consented: false }), failure("INVALID_ENROLLMENT_CONSENT"));
    const first = await completeFaceEnrollment(client, input);
    assert.equal(first.state, "completed");
    assert.equal(templateWrites, 1);
    assert.notEqual(storedEmbedding, JSON.stringify(embedding));
    assert.equal(attendanceQueries, 0);
    const recovered = await completeFaceEnrollment(client, input);
    assert.deepEqual(recovered, first);
    assert.equal(templateWrites, 1);
    assert.equal(attendanceQueries, 0);

    // A second account presenting an already-registered face is refused by name and its session is spent.
    const other = { employeeId: randomUUID(), siteId: randomUUID(), templateId: randomUUID() };
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", Buffer.from(process.env.KIOSK_TEMPLATE_KEY_HEX!, "hex"), iv);
    cipher.setAAD(Buffer.from(`${other.siteId}/${other.employeeId}/${other.templateId}`, "utf8"));
    const sealed = Buffer.concat([iv, cipher.update(JSON.stringify(embedding)), cipher.final(), cipher.getAuthTag()]).toString("base64url");
    others = [{ template_id: other.templateId, site_id: other.siteId, employee_id: other.employeeId, sealed_embedding: sealed, display_name: "Asha Rao" }];
    state = "claimed"; completedAt = null; completionRequestId = null; completionPayloadHash = null; registrationTemplate = null;
    const retryId = randomUUID();
    const retryToken = randomBytes(64).toString("base64url");
    const retryPayload = JSON.stringify(["elt-enrollment-complete-v1", deviceId, claimRequestId, sessionId, retryId, issuedAt, "notice-v1", true, embedding, frames]);
    payloads.set(retryToken, retryPayload);
    const duplicate = await completeFaceEnrollment(client, { ...input, requestId: retryId, integrityToken: retryToken,
      signature: sign("sha256", Buffer.from(signedIntegrityPayload(retryPayload, retryToken)), privateKey).toString("base64url") });
    assert.deepEqual(duplicate, { state: "duplicate", registeredName: "Asha" });
    assert.equal(cancelled, true);
    assert.equal(templateWrites, 1);
  } finally {
    for (const [name, value] of Object.entries(previous)) value === undefined ? delete process.env[name] : process.env[name] = value;
  }
});

test("HR reset increments the global revision once and recovers only an identical audited request", async () => {
  const actorId = randomUUID();
  const employeeId = randomUUID();
  const requestId = randomUUID();
  let revision = 3;
  let audit: Record<string, unknown> | undefined;
  const actor = { employeeId: actorId, authProvider: "synthetic-issuer", authSubject: "synthetic-subject", aal: "aal2" };
  const client = {
    async query(sql: string, values: unknown[] = []) {
      if (sql.includes("FROM access_subject_links")) return { rows: [{ employee_id: actorId, operator_role: "HR" }] };
      if (sql.includes("access_operator_roles role")) return { rows: [{ id: employeeId }] };
      if (sql.includes("INSERT INTO kiosk_face_registrations")) return { rows: [], rowCount: 1 };
      if (sql.includes("SELECT registration_revision, template_id")) return { rows: [{ registration_revision: revision, template_id: revision === 3 ? randomUUID() : null }], rowCount: 1 };
      if (sql.includes("FROM kiosk_face_registration_resets WHERE request_id")) return { rows: audit ? [audit] : [], rowCount: audit ? 1 : 0 };
      if (sql.includes("UPDATE kiosk_face_templates SET retired_at")) return { rows: [], rowCount: 1 };
      if (sql.includes("DELETE FROM kiosk_face_enrollment_codes")) return { rows: [], rowCount: 0 };
      if (sql.includes("UPDATE kiosk_face_reregistration_requests SET resolved_at")) return { rows: [], rowCount: 1 };
      if (sql.includes("UPDATE kiosk_face_enrollment_requests SET state = 'cancelled'")) return { rows: [], rowCount: 1 };
      if (sql.includes("UPDATE kiosk_face_registrations")) {
        revision += 1;
        const updated = { registration_revision: revision, updated_at: new Date() };
        return { rows: [updated], rowCount: 1 };
      }
      if (sql.includes("INSERT INTO kiosk_face_registration_resets")) {
        audit = { actor_employee_id: values[2], reason: values[3], old_revision: values[4], new_revision: values[5], payload_hash: values[6], created_at: new Date() };
        return { rows: [], rowCount: 1 };
      }
      throw new Error(`Unexpected reset query ${sql.slice(0, 100)}`);
    },
  } as unknown as QueryClient;
  const input = { employeeId, requestId, reason: "Synthetic authorized correction" };
  const first = await resetFaceRegistration(client, input, actor);
  assert.equal(first.oldRevision, 3);
  assert.equal(first.registrationRevision, 4);
  assert.equal(first.recovered, false);
  const recovered = await resetFaceRegistration(client, input, actor);
  assert.equal(recovered.registrationRevision, 4);
  assert.equal(recovered.recovered, true);
  await assert.rejects(resetFaceRegistration(client, { ...input, reason: "Changed payload" }, actor), failure("RESET_REQUEST_CONFLICT"));
});
