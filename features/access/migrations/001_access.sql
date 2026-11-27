-- PURPOSE: Store kiosk eligibility, verified account linkage, and receipt reader scope.
CREATE TABLE IF NOT EXISTS access_employees (
  id uuid PRIMARY KEY,
  display_name text NOT NULL CHECK (length(btrim(display_name)) > 0),
  active boolean NOT NULL DEFAULT true
);

CREATE TABLE IF NOT EXISTS access_sites (
  id uuid PRIMARY KEY,
  name text NOT NULL CHECK (length(btrim(name)) > 0),
  active boolean NOT NULL DEFAULT true
);

CREATE TABLE IF NOT EXISTS access_employee_sites (
  employee_id uuid NOT NULL REFERENCES access_employees(id),
  site_id uuid NOT NULL REFERENCES access_sites(id),
  active boolean NOT NULL DEFAULT true,
  PRIMARY KEY (employee_id, site_id)
);

CREATE TABLE IF NOT EXISTS access_subject_links (
  auth_provider text NOT NULL CHECK (length(btrim(auth_provider)) > 0),
  auth_subject text NOT NULL CHECK (length(btrim(auth_subject)) > 0),
  employee_id uuid NOT NULL REFERENCES access_employees(id),
  active boolean NOT NULL DEFAULT true,
  PRIMARY KEY (auth_provider, auth_subject),
  UNIQUE (auth_provider, employee_id)
);

CREATE TABLE IF NOT EXISTS access_operator_roles (
  employee_id uuid PRIMARY KEY REFERENCES access_employees(id),
  role text NOT NULL CHECK (role IN ('HR', 'ADMIN')),
  active boolean NOT NULL DEFAULT true
);

CREATE TABLE IF NOT EXISTS access_manager_reports (
  manager_id uuid NOT NULL REFERENCES access_employees(id),
  report_id uuid NOT NULL REFERENCES access_employees(id),
  active boolean NOT NULL DEFAULT true,
  PRIMARY KEY (manager_id, report_id),
  CHECK (manager_id <> report_id)
);

CREATE INDEX IF NOT EXISTS access_manager_reports_report_idx
  ON access_manager_reports (report_id) WHERE active;
