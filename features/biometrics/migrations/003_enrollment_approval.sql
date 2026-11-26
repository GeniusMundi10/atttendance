-- PURPOSE: Gate self-service face enrollment on HR approval and record employee re-registration requests.
ALTER TABLE kiosk_face_registrations ADD COLUMN approved_at timestamptz;
-- Employees provisioned before the approval gate keep self-service access.
INSERT INTO kiosk_face_registrations(employee_id, approved_at)
SELECT id, clock_timestamp() FROM access_employees
ON CONFLICT (employee_id) DO UPDATE SET approved_at = EXCLUDED.approved_at;

CREATE TABLE kiosk_face_reregistration_requests (
  request_id uuid PRIMARY KEY,
  employee_id uuid NOT NULL REFERENCES access_employees(id),
  reason text NOT NULL CHECK (length(btrim(reason)) BETWEEN 1 AND 1000),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  resolved_at timestamptz
);
CREATE UNIQUE INDEX kiosk_face_reregistration_open_idx
  ON kiosk_face_reregistration_requests(employee_id) WHERE resolved_at IS NULL;
