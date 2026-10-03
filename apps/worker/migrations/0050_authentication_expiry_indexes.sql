-- edgechat-migration-phase: expand

CREATE INDEX idx_sessions_expiry
  ON sessions(expires_at, token_hash);

CREATE INDEX idx_ws_tickets_expiry
  ON ws_tickets(expires_at, ticket_hash);
