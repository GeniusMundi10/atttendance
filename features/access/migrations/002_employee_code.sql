-- PURPOSE: Give every employee a unique human-readable code (ELT00001…) and an optional WhatsApp number for punch alerts.
CREATE SEQUENCE access_employee_code_seq;
-- A volatile default is evaluated per existing row, so current employees are numbered too.
ALTER TABLE access_employees
  ADD COLUMN employee_code text NOT NULL DEFAULT 'ELT' || lpad(nextval('access_employee_code_seq')::text, 5, '0'),
  ADD COLUMN whatsapp_number text CHECK (whatsapp_number ~ '^\+[1-9][0-9]{7,14}$');
ALTER TABLE access_employees ADD CONSTRAINT access_employees_code_key UNIQUE (employee_code);
ALTER SEQUENCE access_employee_code_seq OWNED BY access_employees.employee_code;
