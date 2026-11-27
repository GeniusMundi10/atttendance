// PURPOSE: Verify evidence binding and fail-closed behavior with synthetic fixtures.
import assert from "node:assert/strict";
import { generateKeyPairSync, randomBytes, randomUUID, sign } from "node:crypto";
import { test } from "node:test";
import {
  BiometricsError, checkSequence, hash, punchPayload, signedIntegrityPayload, signedRequest,
} from "./protocol.ts";
import type { Punch } from "./protocol.ts";
import { issueChallenge, verifyDeviceOrigin, verifyEvidence } from "./server.ts";

const deviceId = randomUUID();
const siteId = randomUUID();
const { publicKey, privateKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
const boundKey = publicKey.export({ format: "der", type: "spki" }).toString("base64url");
const signature = (payload: string) => sign("sha256", Buffer.from(payload), privateKey).toString("base64url");
const failure = (code: string) => (error: unknown) => error instanceof BiometricsError && error.code === code;

function fixturePunch(): Punch {
  const request: Punch = {
    deviceId, action: "IN", requestId: randomUUID(), challengeId: randomUUID(),
    evidence: {
      version: 1, employeeId: randomUUID(), templateId: randomUUID(), nonce: randomBytes(32).toString("base64url"),
      frames: [[120, 9200, 6000, 1500], [420, 9300, 7000, 1800], [820, 9450, 6500, 1300]],
      integrityToken: randomBytes(70).toString("base64url"), signature: "",
    },
  };
  request.evidence.signature = signature(signedIntegrityPayload(punchPayload(request), request.evidence.integrityToken));
  return request;
}

function registration() {
  return { rows: [{ site_id: siteId, public_key: boundKey }], rowCount: 1 };
}

test("origin signatures bind all punch fields and remain usable for receipt lookups", async () => {
  const tx = { query: async (sql: string, values?: unknown[]) => {
    assert.match(sql, /FROM kiosk_biometric_devices/);
    assert.deepEqual(values, [deviceId]);
    return registration();
  } };
  const request = fixturePunch();
  await verifyDeviceOrigin(tx, request);
  await assert.rejects(verifyDeviceOrigin(tx, { ...request, action: "OUT" }), failure("INVALID_DEVICE_PROOF"));
  await assert.rejects(verifyDeviceOrigin(tx, { ...request, requestId: randomUUID() }), failure("INVALID_DEVICE_PROOF"));
  await assert.rejects(verifyDeviceOrigin(tx, { ...request, evidence: { ...request.evidence,
    integrityToken: randomBytes(70).toString("base64url"),
  } }), failure("INVALID_DEVICE_PROOF"));
  request.evidence.frames[1][1] = 10000;
  await assert.rejects(verifyDeviceOrigin(tx, request), failure("INVALID_DEVICE_PROOF"));
});

test("challenge issuance verifies signed action and spends a request identifier", async () => {
  const signed = { requestId: randomUUID(), issuedAt: new Date().toISOString(), signature: "" };
  signed.signature = signature(signedRequest("elt-challenge-v1", deviceId, signed, ["OUT"]));
  const header = Buffer.from(JSON.stringify(signed)).toString("base64url");
  let spent = false;
  let insertion: unknown[] | undefined;
  const tx = { query: async (sql: string, values?: unknown[]) => {
    if (sql.includes("FROM kiosk_biometric_devices")) return registration();
    if (sql.includes("INSERT INTO kiosk_biometric_requests")) {
      if (spent) return { rows: [], rowCount: 0 };
      spent = true;
      return { rows: [], rowCount: 1 };
    }
    if (sql.includes("INSERT INTO kiosk_biometric_challenges")) insertion = values;
    return { rows: [], rowCount: 0 };
  } };
  await assert.rejects(issueChallenge(tx, { deviceId, action: "IN" }, header), failure("INVALID_DEVICE_PROOF"));
  const challenge = await issueChallenge(tx, { deviceId, action: "OUT" }, header);
  assert.deepEqual(insertion, [challenge.challengeId, deviceId, "OUT", hash(challenge.nonce),
    new Date(Date.parse(challenge.expiresAt) - 60_000), new Date(challenge.expiresAt)]);
  await assert.rejects(issueChallenge(tx, { deviceId, action: "OUT" }, header), failure("REPLAYED_DEVICE_PROOF"));
});

test("first-time verification rejects unavailable integrity without consuming the challenge", async () => {
  const previous = process.env.KIOSK_PLAY_CERT_SHA256;
  delete process.env.KIOSK_PLAY_CERT_SHA256;
  const request = fixturePunch();
  const tx = { query: async (sql: string, values?: unknown[]) => {
    if (sql.includes("FROM kiosk_biometric_devices")) return registration();
    if (sql.includes("FROM kiosk_biometric_challenges")) {
      assert.deepEqual(values, [request.challengeId, deviceId, request.action, hash(request.evidence.nonce)]);
      return { rows: [{ issued_at: new Date() }], rowCount: 1 };
    }
    assert.match(sql, /FROM kiosk_face_templates/);
    return { rows: [{ active: true }], rowCount: 1 };
  } };
  try {
    await assert.rejects(verifyEvidence(tx, request), failure("KIOSK_INTEGRITY_UNAVAILABLE"));
  } finally {
    if (previous !== undefined) process.env.KIOSK_PLAY_CERT_SHA256 = previous;
  }
});

test("live capture enforces frame spacing and match margins", () => {
  const { frames } = fixturePunch().evidence;
  assert.doesNotThrow(() => checkSequence(frames, true));
  frames[1][0] = 130;
  assert.throws(() => checkSequence(frames, true), failure("BIOMETRIC_VERIFICATION_FAILED"));
  frames[1][0] = 420;
  frames[1][3] = 900;
  assert.throws(() => checkSequence(frames, true), failure("BIOMETRIC_VERIFICATION_FAILED"));
});

test("the local integrity bypass is honoured in development and refused in production", async () => {
  const { verifyPlayIntegrity } = await import("./integrity.ts");
  const saved = { bypass: process.env.KIOSK_INTEGRITY_DEV_BYPASS, env: process.env.NODE_ENV, cert: process.env.KIOSK_PLAY_CERT_SHA256 };
  const env = process.env as Record<string, string | undefined>;
  try {
    delete process.env.KIOSK_PLAY_CERT_SHA256;
    process.env.KIOSK_INTEGRITY_DEV_BYPASS = "1";
    env.NODE_ENV = "development";
    await verifyPlayIntegrity("placeholder", "payload", 0);
    env.NODE_ENV = "production";
    await assert.rejects(verifyPlayIntegrity("placeholder", "payload", 0), failure("KIOSK_INTEGRITY_UNAVAILABLE"));
  } finally {
    for (const [key, value] of [["KIOSK_INTEGRITY_DEV_BYPASS", saved.bypass], ["NODE_ENV", saved.env], ["KIOSK_PLAY_CERT_SHA256", saved.cert]] as const) {
      if (value === undefined) delete env[key]; else env[key] = value;
    }
  }
});
