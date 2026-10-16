package security

import (
	"strings"
	"testing"
)

func TestProductionConfigRejectsUnsafeDefaults(t *testing.T) {
	env := map[string]string{"APP_ENV": "production", "INTERNAL_SERVICE_SHARED_SECRET": strings.Repeat("a", 32), "AUDIT_SIGNING_KEY": strings.Repeat("b", 32), "DATABASE_URL": "postgres://worker:secret@postgres.infrastructure.svc.cluster.local/api_go?sslmode=verify-full", "NATS_URL": "tls://nats.infrastructure.svc.cluster.local:4222", "WEBAUTHN_RP_ID": "example.org", "WEBAUTHN_RP_ORIGIN": "https://vote.example.org"}
	for _, key := range []string{"IDENTITY_SERVICE_URL", "COMPETENCY_SERVICE_URL", "JURISDICTION_SERVICE_URL", "GOVERNANCE_SERVICE_URL", "BALLOT_VERIFIER_URL"} {
		env[key] = "http://api-ts.api-ts.svc.cluster.local:8080"
	}
	get := func(key string) string { return env[key] }
	if err := ProductionConfig(get); err != nil {
		t.Fatal(err)
	}
	for key, value := range map[string]string{"DATABASE_URL": "postgres://worker:secret@localhost/db?sslmode=require", "NATS_URL": "nats://localhost", "BALLOT_VERIFIER_URL": "http://external.example.org", "AUDIT_SIGNING_KEY": "short", "WEBAUTHN_RP_ORIGIN": "https://attacker.org", "MIGRATE_DATABASE_URL": "admin-secret"} {
		old := env[key]
		env[key] = value
		if err := ProductionConfig(get); err == nil {
			t.Errorf("unsafe %s accepted", key)
		}
		env[key] = old
	}
	env["APP_ENV"] = "development"
	env["DATABASE_URL"] = ""
	if err := ProductionConfig(get); err != nil {
		t.Fatal(err)
	}
}

func TestDatabaseTLSModeIsUnambiguous(t *testing.T) {
	for _, query := range []string{"sslmode=verify-full&sslmode=disable", "sslmode=verify-full&SSLMODE=disable"} {
		if err := VerifiedDatabaseURL("postgres://fixture:fixture@localhost/db?" + query); err == nil {
			t.Fatal("ambiguous driver TLS mode accepted")
		}
	}
}
