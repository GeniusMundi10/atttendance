-- PURPOSE: Store authoritative kiosk punches and their transactionally paired audit and outbox records.
CREATE TABLE IF NOT EXISTS attendance_punches (
  sequence bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  punch_id uuid NOT NULL UNIQUE,
  request_id uuid NOT NULL UNIQUE,
  device_id uuid NOT NULL,
  challenge_id uuid NOT NULL,
  proof_digest char(64) NOT NULL CHECK (proof_digest ~ '^[0-9a-f]{64}$'),
  employee_id uuid NOT NULL,
  site_id uuid NOT NULL,
  action text NOT NULL CHECK (action IN ('IN', 'OUT')),
  recorded_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE INDEX IF NOT EXISTS attendance_punches_employee_latest
  ON attendance_punches (employee_id, sequence DESC);

CREATE TABLE IF NOT EXISTS attendance_audit (
  audit_id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  punch_id uuid NOT NULL UNIQUE REFERENCES attendance_punches (punch_id),
  employee_id uuid NOT NULL,
  device_id uuid NOT NULL,
  site_id uuid NOT NULL,
  action text NOT NULL CHECK (action IN ('IN', 'OUT')),
  recorded_at timestamptz NOT NULL
);

CREATE TABLE IF NOT EXISTS attendance_outbox (
  outbox_id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  punch_id uuid NOT NULL UNIQUE REFERENCES attendance_punches (punch_id),
  event_type text NOT NULL CHECK (event_type = 'attendance.punch.recorded'),
  payload jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  published_at timestamptz
);
