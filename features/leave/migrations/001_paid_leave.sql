-- PURPOSE: Record one monthly paid day, explicit work dates, requests, and auditable decisions.
CREATE TABLE leave_work_dates (
  employee_id uuid NOT NULL REFERENCES access_employees(id),
  work_date date NOT NULL,
  PRIMARY KEY (employee_id, work_date)
);

CREATE TABLE leave_balances (
  employee_id uuid NOT NULL REFERENCES access_employees(id),
  month_start date NOT NULL CHECK (EXTRACT(DAY FROM month_start) = 1),
  credit smallint NOT NULL DEFAULT 1 CHECK (credit = 1),
  reserved smallint NOT NULL DEFAULT 0 CHECK (reserved >= 0),
  used smallint NOT NULL DEFAULT 0 CHECK (used >= 0),
  PRIMARY KEY (employee_id, month_start),
  CHECK (reserved + used <= credit)
);

CREATE TABLE leave_requests (
  id uuid PRIMARY KEY,
  employee_id uuid NOT NULL REFERENCES access_employees(id),
  month_start date NOT NULL,
  work_date date NOT NULL,
  status text NOT NULL CHECK (status IN ('PENDING', 'APPROVED', 'REJECTED')),
  note text NOT NULL DEFAULT '' CHECK (length(note) <= 1000),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (employee_id, month_start) REFERENCES leave_balances(employee_id, month_start),
  FOREIGN KEY (employee_id, work_date) REFERENCES leave_work_dates(employee_id, work_date),
  CHECK (work_date >= month_start AND work_date < (month_start + INTERVAL '1 month')::date)
);
CREATE INDEX leave_requests_employee_month_idx ON leave_requests(employee_id, month_start, created_at DESC);
CREATE INDEX leave_requests_pending_idx ON leave_requests(status, created_at) WHERE status = 'PENDING';

CREATE TABLE leave_decisions (
  id uuid PRIMARY KEY,
  request_id uuid NOT NULL REFERENCES leave_requests(id),
  actor_employee_id uuid NOT NULL REFERENCES access_employees(id),
  from_status text NOT NULL CHECK (from_status IN ('PENDING', 'APPROVED', 'REJECTED')),
  to_status text NOT NULL CHECK (to_status IN ('APPROVED', 'REJECTED')),
  reason text NOT NULL DEFAULT '' CHECK (length(reason) <= 1000),
  is_override boolean NOT NULL,
  decided_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX leave_decisions_request_idx ON leave_decisions(request_id, decided_at);
