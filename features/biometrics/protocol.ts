// PURPOSE: Parse and canonicalize the signed Android kiosk protocol.
import { createHash } from "node:crypto";

export class BiometricsError extends Error {
  code: string;
  status: number;

  constructor(code: string, status = 400) {
    super(code);
    this.code = code;
    this.status = status;
  }
}

export type Action = "IN" | "OUT";
export type Frame = [elapsedMs: number, liveness: number, match: number, margin: number];
export type Punch = {
  deviceId: string;
  action: Action;
  requestId: string;
  challengeId: string;
  evidence: {
    version: number;
    employeeId: string;
    templateId: string;
    nonce: string;
    frames: Frame[];
    integrityToken: string;
    signature: string;
  };
};
export type RequestProof = { requestId: string; issuedAt: string; signature: string };
export type Enrollment = RequestProof & {
  deviceId: string;
  employeeId: string;
  setupCode: string;
  embedding: number[];
  frames: Frame[];
  integrityToken: string;
};

export function object(input: unknown, ...keys: string[]): Record<string, unknown> {
  if (!input || typeof input !== "object" || Array.isArray(input)
      || Object.keys(input).length !== keys.length || keys.some(key => !Object.hasOwn(input, key))) {
    throw new BiometricsError("INVALID_KIOSK_REQUEST");
  }
  return input as Record<string, unknown>;
}

export function uuid(value: unknown): string {
  if (typeof value !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value)) {
    throw new BiometricsError("INVALID_KIOSK_REQUEST");
  }
  return value;
}

export function action(value: unknown): Action {
  if (value !== "IN" && value !== "OUT") throw new BiometricsError("INVALID_KIOSK_REQUEST");
  return value;
}

export function opaque(value: unknown, min: number, max: number): string {
  if (typeof value !== "string" || value.length < min || value.length > max
      || !/^[A-Za-z0-9_-]+$/.test(value)) throw new BiometricsError("INVALID_KIOSK_REQUEST");
  return value;
}

function token(value: unknown): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9._=-]{64,16384}$/.test(value)) {
    throw new BiometricsError("INVALID_KIOSK_REQUEST");
  }
  return value;
}

function instant(value: unknown): string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)
      || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString() !== value) {
    throw new BiometricsError("INVALID_KIOSK_REQUEST");
  }
  return value;
}

function sequence(value: unknown): Frame[] {
  if (!Array.isArray(value) || value.length !== 3
      || value.some(frame => !Array.isArray(frame) || frame.length !== 4
        || frame.some(number => !Number.isInteger(number) || number < 0 || number > 10000))) {
    throw new BiometricsError("INVALID_KIOSK_REQUEST");
  }
  return value as Frame[];
}

export function proof(input: unknown): RequestProof {
  if (typeof input === "string") {
    try {
      input = JSON.parse(Buffer.from(opaque(input, 80, 512), "base64url").toString("utf8"));
    } catch {
      throw new BiometricsError("INVALID_DEVICE_PROOF", 401);
    }
  }
  const json = object(input, "requestId", "issuedAt", "signature");
  return { requestId: uuid(json.requestId), issuedAt: instant(json.issuedAt), signature: opaque(json.signature, 64, 108) };
}

export function punch(input: unknown): Punch {
  const json = object(input, "deviceId", "action", "requestId", "challengeId", "evidence");
  const evidence = object(json.evidence, "version", "employeeId", "templateId", "nonce", "frames", "integrityToken", "signature");
  if (evidence.version !== 1) throw new BiometricsError("INVALID_KIOSK_REQUEST");
  return {
    deviceId: uuid(json.deviceId), action: action(json.action), requestId: uuid(json.requestId),
    challengeId: uuid(json.challengeId),
    evidence: {
      version: 1, employeeId: uuid(evidence.employeeId), templateId: uuid(evidence.templateId),
      nonce: opaque(evidence.nonce, 43, 43), frames: sequence(evidence.frames),
      integrityToken: token(evidence.integrityToken), signature: opaque(evidence.signature, 64, 108),
    },
  };
}

export function enrollment(input: unknown): Enrollment {
  const json = object(input, "deviceId", "employeeId", "requestId", "issuedAt", "setupCode", "embedding", "frames", "integrityToken", "signature");
  // Integer coordinates are stable across Kotlin and JavaScript canonical JSON encoders.
  const embedding = json.embedding;
  if (!Array.isArray(embedding) || embedding.length !== 128
      || embedding.some(n => !Number.isInteger(n) || Math.abs(n) > 10000)
      || Math.abs(Math.hypot(...embedding) - 10000) > 10) {
    throw new BiometricsError("INVALID_KIOSK_REQUEST");
  }
  return {
    ...proof({ requestId: json.requestId, issuedAt: json.issuedAt, signature: json.signature }),
    deviceId: uuid(json.deviceId), employeeId: uuid(json.employeeId), setupCode: opaque(json.setupCode, 43, 43),
    frames: sequence(json.frames), embedding, integrityToken: token(json.integrityToken),
  };
}

export function checkSequence(frames: Frame[], match: boolean): void {
  if (frames[0][0] > 3500 || frames[2][0] > 8500 ||
      frames[1][0] - frames[0][0] < 250 || frames[2][0] - frames[1][0] < 250 ||
      frames[2][0] - frames[0][0] < 650 ||
      frames.some(frame => frame[1] < 9000 || (match && (frame[2] < 5000 || frame[3] < 1000)))) {
    throw new BiometricsError("BIOMETRIC_VERIFICATION_FAILED", 403);
  }
}

export function signedRequest(kind: string, deviceId: string, signed: RequestProof, extra: string[] = []): string {
  return JSON.stringify([kind, deviceId, signed.requestId, signed.issuedAt, ...extra]);
}

export function punchPayload(input: Punch): string {
  const { deviceId, action, requestId, challengeId, evidence } = input;
  return JSON.stringify(["elt-punch-v1", deviceId, action, requestId, challengeId,
    evidence.version, evidence.employeeId, evidence.templateId, evidence.nonce, evidence.frames]);
}

export function enrollmentPayload(input: Enrollment): string {
  return JSON.stringify(["elt-enroll-v1", input.deviceId, input.employeeId, input.requestId,
    input.issuedAt, input.setupCode, input.embedding, input.frames]);
}

export function hash(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("base64url");
}

export function signedIntegrityPayload(payload: string, integrityToken: string): string {
  return JSON.stringify([payload, integrityToken]);
}
