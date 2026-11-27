-- PURPOSE: Store shifts, site holiday calendars, effective-dated shift assignments and their audit trail.
CREATE TABLE schedule_shifts (
  id uuid PRIMARY KEY,
  name text NOT NULL UNIQUE CHECK (length(btrim(name)) BETWEEN 1 AND 80),
  start_time time NOT NULL,
  required_minutes smallint NOT NULL CHECK (required_minutes BETWEEN 1 AND 1440),
  half_day_minutes smallint NOT NULL CHECK (half_day_minutes BETWEEN 1 AND 1440),
  weekly_off_days smallint[] NOT NULL DEFAULT '{}'
    CHECK (weekly_off_days <@ ARRAY[1,2,3,4,5,6,7]::smallint[]),
  CHECK (half_day_minutes <= required_minutes)
);
-- ISO weekday numbers: 1 = Monday ... 7 = Sunday.
-- General Shift values come from the Attendance and Leave Policy (9:30 AM report time, 9 hours
-- full day, 4.5 hours half day) and the HR flow workbook (Sunday weekly off).
INSERT INTO schedule_shifts (id, name, start_time, required_minutes, half_day_minutes, weekly_off_days)
VALUES ('6f1d0c1e-5a52-4f0e-9a39-0a1b8f3c2d01', 'General Shift', '09:30', 540, 270, ARRAY[7]::smallint[]);
CREATE TABLE schedule_holidays (
  id uuid PRIMARY KEY,
  site_id uuid NOT NULL REFERENCES access_sites(id),
  shift_id uuid NOT NULL REFERENCES schedule_shifts(id),
  holiday_date date NOT NULL,
  name text NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 120),
  classification text NOT NULL CHECK (classification IN ('HOLIDAY', 'RESTRICTED')),
  source text NOT NULL DEFAULT '' CHECK (length(source) <= 200),
  created_at timestamptz NOT NULL DEFAULT now(),
  removed_at timestamptz
);
CREATE UNIQUE INDEX schedule_holidays_day_idx
  ON schedule_holidays (site_id, shift_id, holiday_date) WHERE removed_at IS NULL;
CREATE TABLE schedule_assignments (
  id uuid PRIMARY KEY,
  employee_id uuid NOT NULL REFERENCES access_employees(id),
  site_id uuid NOT NULL REFERENCES access_sites(id),
  shift_id uuid NOT NULL REFERENCES schedule_shifts(id),
  effective_from date NOT NULL,
  actor_employee_id uuid REFERENCES access_employees(id),
  source text NOT NULL DEFAULT 'portal' CHECK (source IN ('portal', 'provision')),
  reason text NOT NULL CHECK (length(btrim(reason)) BETWEEN 1 AND 1000),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (employee_id, effective_from),
  CHECK (actor_employee_id IS NOT NULL OR source = 'provision')
);
CREATE TABLE schedule_audit (
  id uuid PRIMARY KEY,
  actor_employee_id uuid REFERENCES access_employees(id),
  action text NOT NULL CHECK (length(action) BETWEEN 1 AND 40),
  subject text NOT NULL CHECK (length(subject) <= 200),
  detail jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX schedule_audit_time_idx ON schedule_audit (created_at DESC);
