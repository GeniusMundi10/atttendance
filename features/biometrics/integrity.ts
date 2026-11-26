// PURPOSE: Verify production Google Play Integrity tokens and bind verdicts to kiosk evidence.
import { createSign } from "node:crypto";
import { BiometricsError, hash } from "./protocol.ts";

const tokenEndpoint = "https://oauth2.googleapis.com/token";
const packageName = "com.elt.attendance.kiosk";
const scope = "https://www.googleapis.com/auth/playintegrity";
const deadline = 7000;

let authorization: { value: string; expiresAt: number } | undefined;
let authorizing: Promise<string> | undefined;

async function oauthToken() {
  if (authorization && authorization.expiresAt > Date.now()) return authorization.value;
  if (authorizing) return authorizing;
  authorizing = requestOAuth().finally(() => { authorizing = undefined; });
  return authorizing;
}

async function requestOAuth() {
  const json = process.env.KIOSK_PLAY_SERVICE_ACCOUNT_JSON;
  if (!json) throw new BiometricsError("KIOSK_INTEGRITY_UNAVAILABLE", 503);
  const { client_email, private_key } = JSON.parse(json);
  if (typeof client_email !== "string" || typeof private_key !== "string") {
    throw new BiometricsError("KIOSK_INTEGRITY_UNAVAILABLE", 503);
  }
  const now = Math.floor(Date.now() / 1000);
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
  const proof = [
    encode({ alg: "RS256", typ: "JWT" }),
    encode({ iss: client_email, scope, aud: tokenEndpoint, iat: now, exp: now + 300 }),
  ].join(".");
  const signature = createSign("RSA-SHA256").update(proof).sign(private_key, "base64url");
  const response = await fetch(tokenEndpoint, {
    method: "POST",
    body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion: proof + "." + signature }),
    signal: AbortSignal.timeout(deadline),
  });
  if (!response.ok) throw new BiometricsError("KIOSK_INTEGRITY_UNAVAILABLE", 503);
  const result = await response.json();
  if (typeof result.access_token !== "string" || !Number.isFinite(result.expires_in)) {
    throw new BiometricsError("KIOSK_INTEGRITY_UNAVAILABLE", 503);
  }
  authorization = { value: result.access_token, expiresAt: Date.now() + Math.max(0, result.expires_in - 60) * 1000 };
  return authorization.value;
}

export async function verifyPlayIntegrity(token: string, payload: string, earliest: number): Promise<void> {
  // ponytail: local end-to-end testing with a sideloaded debug APK. Skips only Google's verdict; device signatures,
  // liveness metrics and everything else are still verified. Refused under NODE_ENV=production (next build/start).
  if (process.env.KIOSK_INTEGRITY_DEV_BYPASS === "1" && process.env.NODE_ENV !== "production") return;
  const cert = process.env.KIOSK_PLAY_CERT_SHA256;
  if (!cert || !/^[\da-f]{64}$/i.test(cert)) throw new BiometricsError("KIOSK_INTEGRITY_UNAVAILABLE", 503);
  let result;
  try {
    const bearer = await oauthToken();
    const response = await fetch(`https://playintegrity.googleapis.com/v1/${packageName}:decodeIntegrityToken`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${bearer}` },
      body: JSON.stringify({ integrity_token: token }),
      signal: AbortSignal.timeout(deadline),
    });
    if (response.status === 400) throw new BiometricsError("KIOSK_INTEGRITY_REJECTED", 403);
    if (!response.ok) throw new BiometricsError("KIOSK_INTEGRITY_UNAVAILABLE", 503);
    result = (await response.json()).tokenPayloadExternal;
  } catch (error) {
    if (error instanceof BiometricsError) throw error;
    throw new BiometricsError("KIOSK_INTEGRITY_UNAVAILABLE", 503);
  }
  const details = result?.requestDetails;
  const app = result?.appIntegrity;
  const verdicts = result?.deviceIntegrity?.deviceRecognitionVerdict;
  const certificates = app?.certificateSha256Digest;
  const now = Date.now();
  const timestamp = Number(details?.timestampMillis);
  if (details?.requestPackageName !== packageName || details?.requestHash !== hash(payload)
      || !Number.isSafeInteger(timestamp) || timestamp < earliest || timestamp < now - 75000 || timestamp > now + 5000
      || app?.appRecognitionVerdict !== "PLAY_RECOGNIZED" || app?.packageName !== packageName
      || !Array.isArray(certificates) || !certificates.includes(Buffer.from(cert, "hex").toString("base64url"))
      || !Array.isArray(verdicts) || !verdicts.includes("MEETS_STRONG_INTEGRITY")) {
    throw new BiometricsError("KIOSK_INTEGRITY_REJECTED", 403);
  }
}
