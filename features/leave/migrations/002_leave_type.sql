-- PURPOSE: Distinguish paid leave (uses the monthly paid day) from unpaid leave (recorded only, no balance).
ALTER TABLE leave_requests
  ADD COLUMN leave_type text NOT NULL DEFAULT 'PAID' CHECK (leave_type IN ('PAID', 'UNPAID'));
