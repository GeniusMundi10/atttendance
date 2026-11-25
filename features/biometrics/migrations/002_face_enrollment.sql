-- PURPOSE: Store employee-wide face registration, recoverable enrollment sessions, durable throttles, and audited HR resets.
ALTER TABLE kiosk_face_templates ADD COLUMN retired_at timestamptz;
ALTER TABLE kiosk_face_templates DROP CONSTRAINT kiosk_face_templates_site_id_employee_id_key;
ALTER TABLE kiosk_face_templates ADD CONSTRAINT kiosk_face_templates_template_employee_key UNIQUE (template_id, employee_id);

CREATE TABLE kiosk_face_registrations (
  employee_id uuid PRIMARY KEY REFERENCES access_employees(id),
  registration_revision integer NOT NULL DEFAULT 1 CHECK (registration_revision > 0),
  template_id uuid REFERENCES kiosk_face_templates(template_id),
  registered_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (template_id, employee_id) REFERENCES kiosk_face_templates(template_id, employee_id),
  CHECK ((template_id IS NULL) = (registered_at IS NULL))
);

-- Existing template rows are account-wide registrations. Keep one deterministic canonical row.
INSERT INTO kiosk_face_registrations(employee_id, registration_revision, template_id, registered_at)
SELECT DISTINCT ON (template.employee_id)
       template.employee_id, 1, template.template_id, clock_timestamp()
  FROM kiosk_face_templates template
 ORDER BY template.employee_id, template.template_id
ON CONFLICT (employee_id) DO NOTHING;

UPDATE kiosk_face_templates template
   SET retired_at = clock_timestamp()
 WHERE NOT EXISTS (
   SELECT 1 FROM kiosk_face_registrations registration
    WHERE registration.employee_id = template.employee_id
      AND registration.template_id = template.template_id
 );

CREATE UNIQUE INDEX kiosk_face_templates_one_active_employee_idx
  ON kiosk_face_templates(employee_id) WHERE retired_at IS NULL;
CREATE INDEX kiosk_face_registrations_template_idx
  ON kiosk_face_registrations(template_id) WHERE template_id IS NOT NULL;

CREATE TABLE kiosk_face_enrollment_requests (
  request_id uuid PRIMARY KEY,
  employee_id uuid NOT NULL REFERENCES access_employees(id),
  site_id uuid NOT NULL REFERENCES access_sites(id),
  registration_revision integer NOT NULL CHECK (registration_revision > 0),
  payload_hash text NOT NULL CHECK (length(payload_hash) = 43),
  code_digest text NOT NULL CHECK (length(code_digest) = 43),
  state text NOT NULL CHECK (state IN ('issued','claimed','completed','cancelled','expired','superseded')),
  issued_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  expires_at timestamptz NOT NULL,
  claim_request_id uuid UNIQUE,
  claim_payload_hash text,
  claimed_device_id uuid REFERENCES kiosk_biometric_devices(device_id),
  session_id uuid UNIQUE,
  capture_expires_at timestamptz,
  completion_request_id uuid,
  completion_payload_hash text,
  completed_at timestamptz,
  CHECK ((state IN ('claimed','completed') AND session_id IS NOT NULL AND claimed_device_id IS NOT NULL)
      OR state NOT IN ('claimed','completed'))
);
CREATE UNIQUE INDEX kiosk_face_enrollment_live_digest_idx
  ON kiosk_face_enrollment_requests(site_id, code_digest) WHERE state = 'issued';
CREATE INDEX kiosk_face_enrollment_employee_state_idx
  ON kiosk_face_enrollment_requests(employee_id, state, expires_at);
CREATE INDEX kiosk_face_enrollment_claim_device_idx
  ON kiosk_face_enrollment_requests(claimed_device_id, claim_request_id);

CREATE TABLE kiosk_face_enrollment_limits (
  scope text NOT NULL CHECK (scope IN ('issuance-hour','claim-device-window')),
  subject text NOT NULL,
  bucket_start timestamptz NOT NULL,
  hits integer NOT NULL CHECK (hits > 0),
  PRIMARY KEY (scope, subject, bucket_start)
);
CREATE INDEX kiosk_face_enrollment_limits_bucket_idx
  ON kiosk_face_enrollment_limits(bucket_start);

CREATE TABLE kiosk_face_registration_resets (
  request_id uuid PRIMARY KEY,
  employee_id uuid NOT NULL REFERENCES access_employees(id),
  actor_employee_id uuid NOT NULL REFERENCES access_employees(id),
  reason text NOT NULL CHECK (length(btrim(reason)) BETWEEN 1 AND 1000),
  old_revision integer NOT NULL CHECK (old_revision > 0),
  new_revision integer NOT NULL CHECK (new_revision = old_revision + 1),
  payload_hash text NOT NULL CHECK (length(payload_hash) = 43),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX kiosk_face_registration_resets_employee_idx
  ON kiosk_face_registration_resets(employee_id, created_at DESC);
