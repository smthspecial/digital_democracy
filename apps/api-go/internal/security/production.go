package security

import (
	"fmt"
	"net/url"
	"strings"
)

// ProductionConfig rejects development defaults before any network connection.
// Plain HTTP is only allowed for mesh-addressed internal services.
func ProductionConfig(env func(string) string) error {
	if env("APP_ENV") != "production" {
		return nil
	}
	for _, key := range []string{"INTERNAL_SERVICE_SHARED_SECRET", "AUDIT_SIGNING_KEY"} {
		if len(env(key)) < 32 {
			return fmt.Errorf("production requires %s with at least 32 characters", key)
		}
	}
	if err := VerifiedDatabaseURL(env("DATABASE_URL")); err != nil {
		return err
	}
	broker, err := url.Parse(env("NATS_URL"))
	if err != nil || broker.Scheme != "tls" || broker.Hostname() == "" {
		return fmt.Errorf("production NATS_URL requires verified TLS")
	}
	if env("MIGRATE_DATABASE_URL") != "" {
		return fmt.Errorf("migration credentials must not be supplied to runtime")
	}
	for _, key := range []string{"IDENTITY_SERVICE_URL", "COMPETENCY_SERVICE_URL", "JURISDICTION_SERVICE_URL", "GOVERNANCE_SERVICE_URL", "BALLOT_VERIFIER_URL"} {
		peer, err := url.Parse(env(key))
		if err != nil || peer.Hostname() == "" || peer.User != nil ||
			(peer.Scheme != "https" && (peer.Scheme != "http" || !strings.HasSuffix(peer.Hostname(), ".svc.cluster.local"))) {
			return fmt.Errorf("production %s requires HTTPS or a mesh-local service address", key)
		}
	}
	origin, err := url.Parse(env("WEBAUTHN_RP_ORIGIN"))
	rp := env("WEBAUTHN_RP_ID")
	if err != nil || origin.Scheme != "https" || origin.User != nil || rp == "" || rp == "localhost" ||
		(origin.Hostname() != rp && !strings.HasSuffix(origin.Hostname(), "."+rp)) {
		return fmt.Errorf("production passkeys require a matching HTTPS relying-party origin")
	}
	return nil
}

func VerifiedDatabaseURL(raw string) error {
	u, err := url.Parse(raw)
	if err != nil || (u.Scheme != "postgres" && u.Scheme != "postgresql") || u.Hostname() == "" || u.Query().Get("sslmode") != "verify-full" {
		return fmt.Errorf("production DATABASE_URL requires sslmode=verify-full")
	}
	for key, values := range u.Query() {
		if strings.EqualFold(key, "sslmode") && (key != "sslmode" || len(values) != 1) {
			return fmt.Errorf("production DATABASE_URL requires one unambiguous sslmode")
		}
	}
	return nil
}
