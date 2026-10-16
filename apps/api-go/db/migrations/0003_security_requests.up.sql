CREATE TABLE security_request (
 signature_hash TEXT PRIMARY KEY,
 expires_at TIMESTAMPTZ NOT NULL
);
CREATE INDEX security_request_expiry ON security_request(expires_at);
ALTER TABLE security_request ENABLE ROW LEVEL SECURITY;
ALTER TABLE security_request FORCE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, DELETE ON security_request TO api_worker;
CREATE POLICY security_request_worker ON security_request TO api_worker USING (true) WITH CHECK (true);
