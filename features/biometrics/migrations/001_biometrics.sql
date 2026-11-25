-- PURPOSE: Store registered signing keys, consumable challenges, and encrypted site face templates.
CREATE TABLE kiosk_biometric_devices (
  device_id uuid PRIMARY KEY,
  site_id uuid NOT NULL,
  public_key text NOT NULL UNIQUE CHECK (length(public_key) BETWEEN 100 AND 200),
  active boolean NOT NULL DEFAULT true
);

CREATE TABLE kiosk_biometric_requests (
  device_id uuid NOT NULL REFERENCES kiosk_biometric_devices(device_id),
  request_id uuid NOT NULL,
  received_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (device_id, request_id)
);
CREATE INDEX kiosk_biometric_requests_received_idx ON kiosk_biometric_requests(received_at);

CREATE TABLE kiosk_biometric_challenges (
  challenge_id uuid PRIMARY KEY,
  device_id uuid NOT NULL REFERENCES kiosk_biometric_devices(device_id),
  action text NOT NULL CHECK (action IN ('IN', 'OUT')),
  nonce_hash text NOT NULL,
  issued_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz
);
CREATE INDEX kiosk_biometric_challenges_device_issued_idx ON kiosk_biometric_challenges(device_id, issued_at);

CREATE TABLE kiosk_face_templates (
  template_id uuid PRIMARY KEY,
  site_id uuid NOT NULL,
  employee_id uuid NOT NULL,
  sealed_embedding text NOT NULL,
  UNIQUE (site_id, employee_id)
);

CREATE TABLE kiosk_face_enrollment_codes (
  code_hash text PRIMARY KEY,
  device_id uuid NOT NULL REFERENCES kiosk_biometric_devices(device_id),
  employee_id uuid NOT NULL,
  expires_at timestamptz NOT NULL
);
