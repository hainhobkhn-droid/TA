ALTER TABLE webhook_event
  ADD COLUMN attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  ADD COLUMN last_attempt_at timestamptz,
  ADD COLUMN next_attempt_at timestamptz NOT NULL DEFAULT now();
CREATE INDEX webhook_event_due ON webhook_event(next_attempt_at,received_at)
  WHERE status='pending';
