package auth

// Postgres-backed Store tests (ADR-029). See voting/pgstore_test.go for the
// TEST_DATABASE_URL contract.

import (
	"context"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
)

func pgTestStore(t *testing.T) *PGStore {
	t.Helper()
	pool, err := pgxpool.New(context.Background(), testDatabaseURL(t))
	if err != nil {
		t.Fatalf("pg connect: %v", err)
	}
	t.Cleanup(pool.Close)
	ensureMigrated(t, pool)
	for _, table := range []string{"auth_event", "mfa_factor", "session"} {
		if _, err := pool.Exec(context.Background(), "TRUNCATE "+table+" CASCADE"); err != nil {
			t.Fatalf("truncate %s: %v", table, err)
		}
	}
	return NewPGStore(pool)
}

// DP-059 login/refresh + DP-060 enrollment + DP-061 step-up hold on Postgres.
func TestPGAuthLoginRefreshStepUp(t *testing.T) {
	pg := pgTestStore(t)
	svc := NewService(pg, nil, nil, nil)
	now := time.Now().UTC()
	citizen := newID()

	if _, err := svc.Enroll(EnrollInput{CitizenID: citizen, FactorType: FactorTOTP, TOTPSecret: "s3cret"}, now); err != nil {
		t.Fatal(err)
	}
	_, tokens, err := svc.Login(LoginInput{
		CitizenID: citizen, DeviceFingerprint: "fp", IPSubnet: "sub",
		StepUpFactorType: FactorTOTP, StepUpProof: "123456",
	}, now)
	if err != nil || tokens.AssuranceTier != TierT2 {
		t.Fatalf("login = %v, %v", tokens, err)
	}

	refreshed, err := svc.Refresh(tokens.RefreshToken, "fp", "sub", "10.0.0.2", now.Add(time.Minute))
	if err != nil {
		t.Fatalf("refresh: %v", err)
	}
	if _, err := svc.Refresh(tokens.RefreshToken, "fp", "sub", "10.0.0.2", now.Add(2*time.Minute)); err != ErrUnauthorized {
		t.Fatalf("reused refresh = %v, want ErrUnauthorized", err)
	}

	got, err := svc.Validate(refreshed.AccessToken, now.Add(3*time.Minute))
	if err != nil || got.CitizenID != citizen || got.AssuranceTier != TierT2 {
		t.Fatalf("validate = %+v, %v", got, err)
	}

	stepped, err := svc.StepUp(StepUpInput{SessionID: tokens.SessionID, FactorType: FactorTOTP, Proof: "654321"}, now.Add(4*time.Minute))
	if err != nil || stepped.AssuranceTier != TierT2 {
		t.Fatalf("stepup = %v, %v", stepped, err)
	}
	if err := svc.Logout(stepped.AccessToken); err != nil {
		t.Fatalf("logout: %v", err)
	}
	if _, err := svc.Validate(stepped.AccessToken, now.Add(5*time.Minute)); err != ErrUnauthorized {
		t.Fatalf("post-logout validate = %v, want ErrUnauthorized", err)
	}
}

// DP-066 device mismatch suspends; DP-067 purges only expired rows.
func TestPGAuthAnomalyAndPurge(t *testing.T) {
	pg := pgTestStore(t)
	svc := NewService(pg, nil, nil, nil)
	now := time.Now().UTC()
	citizen := newID()

	_, tokens, err := svc.Login(LoginInput{CitizenID: citizen, DeviceFingerprint: "fp", IPSubnet: "sub"}, now)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := svc.Refresh(tokens.RefreshToken, "other-fp", "sub", "10.9.9.9", now.Add(time.Minute)); err != ErrUnauthorized {
		t.Fatalf("device mismatch = %v, want ErrUnauthorized", err)
	}
	sess, err := pg.GetSession(tokens.SessionID)
	if err != nil || sess.Status != SessionSuspended {
		t.Fatalf("session = %+v, %v", sess, err)
	}

	n, err := svc.Purge(now)
	if err != nil || n != 0 {
		t.Fatalf("purge live = %d, %v", n, err)
	}
	if _, err := svc.RevokeAll(citizen, now); err != nil {
		t.Fatal(err)
	}
	n, err = svc.Purge(now.Add(RefreshTTL + PurgeGrace + time.Hour))
	if err != nil || n != 0 {
		t.Fatalf("purge revoked = %d, %v (revoked rows are retained)", n, err)
	}
}
