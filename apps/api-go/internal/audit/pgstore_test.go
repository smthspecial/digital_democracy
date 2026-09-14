package audit

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
	if testDatabaseURL() == "" {
		t.Skip("TEST_DATABASE_URL unset")
	}
	pool, err := pgxpool.New(context.Background(), testDatabaseURL())
	if err != nil {
		t.Fatalf("pg connect: %v", err)
	}
	t.Cleanup(pool.Close)
	ensureMigrated(t, pool)
	for _, table := range []string{"audit_log", "constitutional_review", "constitutional_right", "protocol_change"} {
		if _, err := pool.Exec(context.Background(), "TRUNCATE "+table+" CASCADE"); err != nil {
			t.Fatalf("truncate %s: %v", table, err)
		}
	}
	return NewPGStore(pool)
}

// DP-036 chaining + idempotent redelivery hold on Postgres; the SQL chain
// trigger independently enforces prev_hash.
func TestPGAuditAppendFlow(t *testing.T) {
	pg := pgTestStore(t)
	svc := NewService(pg, nil)

	first, err := svc.Append(ActionProposalCreated, "test", "payload-1", "evt-1")
	if err != nil {
		t.Fatal(err)
	}
	if first.PrevHash != GenesisPrevHash {
		t.Fatalf("first prev = %q", first.PrevHash)
	}
	second, err := svc.Append(ActionVoteCertified, "test", "payload-2", "evt-2")
	if err != nil {
		t.Fatal(err)
	}
	if second.PrevHash != first.PayloadHash {
		t.Fatal("chain must link prev_hash to the previous payload_hash (ARCH-023 §4.4)")
	}
	redelivered, err := svc.Append(ActionProposalCreated, "test", "payload-1", "evt-1")
	if err != nil {
		t.Fatal(err)
	}
	if redelivered.ID != first.ID {
		t.Fatal("redelivery must return the original row")
	}
	ok, bad, err := pg.VerifyChain()
	if err != nil || !ok {
		t.Fatalf("chain valid=%v bad=%d err=%v", ok, bad, err)
	}
}

// DP-034 + DP-043 hold on Postgres.
func TestPGAuditReviewAndGate(t *testing.T) {
	pg := pgTestStore(t)
	svc := NewService(pg, nil)

	right, err := pg.CreateRight("free speech", "expression", true)
	if err != nil {
		t.Fatal(err)
	}
	_, blocked, err := svc.TriggerReview(ReviewTrigger{
		ProposalID: newID(), AffectedRightIDs: []string{right.ID}, ReviewerRef: "rb",
	})
	if err != nil || !blocked {
		t.Fatalf("TriggerReview blocked=%v err=%v", blocked, err)
	}

	now := time.Now().UTC()
	change, err := svc.RegisterChange(RegisterChangeInput{
		ChangeRef:         "proto-x",
		RequiredApprovals: []string{"a1"},
		DelayUntil:        now.Add(time.Hour),
		VisibleSince:      now.Add(-time.Hour),
	})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := svc.ReleaseChange(change.ID, now.Add(2*time.Hour)); err == nil {
		t.Fatal("release without approvals must fail")
	}
	if _, err := svc.RecordApproval(change.ID, "a1", "body-1", now); err != nil {
		t.Fatal(err)
	}
	released, err := svc.ReleaseChange(change.ID, now.Add(2*time.Hour))
	if err != nil {
		t.Fatal(err)
	}
	if released.Status != ChangeReleased {
		t.Fatalf("status = %q", released.Status)
	}
}
