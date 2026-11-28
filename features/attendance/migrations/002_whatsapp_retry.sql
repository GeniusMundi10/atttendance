-- PURPOSE: Schedule failed WhatsApp notifications without blocking newly queued punches.
ALTER TABLE attendance_outbox ADD COLUMN next_attempt_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP;

CREATE INDEX attendance_outbox_due ON attendance_outbox (next_attempt_at, outbox_id)
  WHERE published_at IS NULL;
