-- PURPOSE: Hold self-service account sign-ups until HR/ADMIN approves them into linked employees.
CREATE TABLE access_signup_requests (
  request_id uuid NOT NULL UNIQUE DEFAULT gen_random_uuid(),
  auth_provider text NOT NULL CHECK (length(btrim(auth_provider)) > 0),
  auth_subject text NOT NULL CHECK (length(btrim(auth_subject)) > 0),
  email text NOT NULL CHECK (length(email) BETWEEN 3 AND 320),
  display_name text NOT NULL CHECK (length(btrim(display_name)) BETWEEN 1 AND 120),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  employee_id uuid REFERENCES access_employees(id),
  PRIMARY KEY (auth_provider, auth_subject)
);
CREATE INDEX access_signup_requests_pending_idx ON access_signup_requests(created_at) WHERE employee_id IS NULL;
