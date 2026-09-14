package voting

// Postgres-backed Store tests (ADR-029). They run against a real database
// and are skipped without one:
//
//	TEST_DATABASE_URL=postgres://dd:dd@localhost:5432/api_go go test ./internal/voting/ -run TestPGVoting
//
// The database must have db/migrations/0001_init applied (pg.Up or psql).
// Tables are truncated (CASCADE from vote_session), never dropped.

import (
	"context"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
)

func pgTestStore(t *testing.T) *PGStore {
	t.Helper()
	url := pgTestURL(t)
	pool, err := pgxpool.New(context.Background(), url)
	if err != nil {
		t.Fatalf("pg connect: %v", err)
	}
	t.Cleanup(pool.Close)
	ensureMigrated(t, pool)
	for _, table := range []string{"ballot", "eligibility_token", "vote_option", "vote_session"} {
		if _, err := pool.Exec(context.Background(), "TRUNCATE "+table+" CASCADE"); err != nil {
			t.Fatalf("truncate %s: %v", table, err)
		}
	}
	return NewPGStore(pool)
}

func pgTestURL(t *testing.T) string {
	t.Helper()
	url := testDatabaseURL()
	if url == "" {
		t.Skip("TEST_DATABASE_URL unset")
	}
	return url
}

func pgTestSession(t *testing.T, svc *Service) *VoteSession {
	t.Helper()
	now := time.Now().UTC()
	vs, err := svc.CreateSession(CreateSessionInput{
		ProposalID:       newID(),
		JurisdictionID:   newID(),
		Method:           MethodApproval,
		ThresholdRule:    ThresholdSimpleMajority,
		MinParticipation: 0.5,
		CoolingOffUntil:  now.Add(-time.Hour),
		OpensAt:          now.Add(-time.Minute),
		ClosesAt:         now.Add(time.Hour),
	})
	if err != nil {
		t.Fatalf("CreateSession: %v", err)
	}
	if _, err := svc.TryOpen(vs.ID, time.Now().UTC()); err != nil {
		t.Fatalf("TryOpen: %v", err)
	}
	return vs
}

// DP-025 idempotency + DP-016 atomic single-use hold on Postgres too.
func TestPGVotingCastFlow(t *testing.T) {
	pg := pgTestStore(t)
	svc := NewService(pg, nil, nil)
	vs := pgTestSession(t, svc)
	citizen := newID()

	first, err := svc.IssueTokens(vs.ID, []string{citizen})
	if err != nil || first[0].TokenBlind == "" {
		t.Fatalf("IssueTokens = %v, %v", first, err)
	}
	second, err := svc.IssueTokens(vs.ID, []string{citizen})
	if err != nil {
		t.Fatal(err)
	}
	if second[0].ID != first[0].ID || second[0].TokenBlind != "" {
		t.Fatal("re-issue must return the existing row without the raw blind")
	}

	b, err := svc.CastBallot(vs.ID, first[0].ID, first[0].TokenBlind, "choice-a", citizen)
	if err != nil || b.VerificationCode == "" {
		t.Fatalf("CastBallot = %v, %v", b, err)
	}
	if _, err := svc.CastBallot(vs.ID, first[0].ID, first[0].TokenBlind, "choice-a", citizen); err != ErrConflict {
		t.Fatalf("double cast = %v, want ErrConflict", err)
	}

	found, err := svc.VerifyBallot(b.VerificationCode)
	if err != nil || found.SessionID != vs.ID {
		t.Fatalf("VerifyBallot = %v, %v", found, err)
	}

	// Forged blind never matches the stored hash.
	other, _ := svc.IssueTokens(vs.ID, []string{newID()})
	if _, err := svc.CastBallot(vs.ID, other[0].ID, "forged", "x", ""); err != ErrInvalid {
		t.Fatalf("forged blind = %v, want ErrInvalid", err)
	}
}

// Tally outcome + quorum certification evaluate on Postgres rows.
func TestPGVotingTallyCertify(t *testing.T) {
	pg := pgTestStore(t)
	svc := NewService(pg, nil, nil)
	now := time.Now().UTC()
	vs, err := svc.CreateSession(CreateSessionInput{
		ProposalID: newID(), JurisdictionID: newID(),
		Method: MethodApproval, ThresholdRule: ThresholdSimpleMajority,
		MinParticipation: 0.5,
		CoolingOffUntil:  now.Add(-time.Hour), OpensAt: now.Add(-time.Hour), ClosesAt: now.Add(time.Hour),
	})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := svc.TryOpen(vs.ID, now); err != nil {
		t.Fatal(err)
	}
	tokens, err := svc.IssueTokens(vs.ID, []string{newID(), newID()})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := svc.CastBallot(vs.ID, tokens[0].ID, tokens[0].TokenBlind, "a", ""); err != nil {
		t.Fatal(err)
	}
	if _, err := svc.CastBallot(vs.ID, tokens[1].ID, tokens[1].TokenBlind, "a", ""); err != nil {
		t.Fatal(err)
	}
	if _, err := svc.TryClose(vs.ID, now.Add(2*time.Hour)); err != nil {
		t.Fatal(err)
	}
	out, err := svc.Certify(vs.ID)
	if err != nil {
		t.Fatal(err)
	}
	if out.Status != SessionCertified || out.TallyResult == nil || !out.TallyResult.Decided || out.TallyResult.Winner != "a" {
		t.Fatalf("certified = %+v", out)
	}
}
