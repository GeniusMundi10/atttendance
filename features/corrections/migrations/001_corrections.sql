-- PURPOSE: Reserve employee correction dates and retain each per-date decision without changing punches.
CREATE TABLE correction_requests (
  request_id uuid PRIMARY KEY,
  employee_id uuid NOT NULL REFERENCES access_employees(id),
  reason text NOT NULL CHECK (length(btrim(reason)) BETWEEN 1 AND 1000),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE TABLE correction_days (
  day_id uuid PRIMARY KEY,
  request_id uuid NOT NULL REFERENCES correction_requests(request_id),
  employee_id uuid NOT NULL REFERENCES access_employees(id),
  work_date date NOT NULL,
  proposed_in_at timestamptz,
  proposed_out_at timestamptz,
  status text NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING','APPROVED','REJECTED')),
  revision integer NOT NULL DEFAULT 1 CHECK (revision > 0),
  decided_by uuid REFERENCES access_employees(id),
  decision_reason text,
  decided_at timestamptz,
  CHECK (proposed_in_at IS NOT NULL OR proposed_out_at IS NOT NULL),
  CHECK (proposed_in_at IS NULL OR proposed_out_at IS NULL OR proposed_in_at < proposed_out_at),
  CHECK ((status = 'PENDING' AND decided_by IS NULL AND decision_reason IS NULL AND decided_at IS NULL)
      OR (status <> 'PENDING' AND decided_by IS NOT NULL AND length(btrim(decision_reason)) BETWEEN 1 AND 1000 AND decided_at IS NOT NULL))
);

CREATE UNIQUE INDEX correction_active_employee_date
  ON correction_days(employee_id,work_date) WHERE status IN ('PENDING','APPROVED');
CREATE INDEX correction_days_employee_date ON correction_days(employee_id,work_date DESC);
CREATE INDEX correction_days_pending ON correction_days(status,work_date) WHERE status = 'PENDING';
