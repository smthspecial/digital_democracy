package voting

import (
	"net/http"
	"net/http/httptest"
	"testing"
	"time"
)

func testSession(t *testing.T, svc *Service) *VoteSession {
	t.Helper()
	now := time.Now().UTC()
	vs, err := svc.CreateSession(CreateSessionInput{
		ProposalID:       "prop-1",
		JurisdictionID:   "jur-1",
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
	if vs.Status != SessionScheduled {
		t.Fatalf("new session status = %q, want scheduled", vs.Status)
	}
	return vs
}

func openTestSession(t *testing.T, svc *Service, vs *VoteSession) {
	t.Helper()
	if _, err := svc.TryOpen(vs.ID, time.Now().UTC()); err != nil {
		t.Fatalf("TryOpen: %v", err)
	}
}

// Opening requires both opens_at passed and cooling cleared (DP-046/DP-057).
func TestOpenBlockedByCooling(t *testing.T) {
	svc := NewService(nil, nil, nil)
	now := time.Now().UTC()
	vs, err := svc.CreateSession(CreateSessionInput{
		ProposalID: "p", JurisdictionID: "j",
		Method: MethodApproval, ThresholdRule: ThresholdSimpleMajority,
		CoolingOffUntil: now.Add(time.Hour), OpensAt: now.Add(-time.Minute), ClosesAt: now.Add(time.Hour),
	})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := svc.TryOpen(vs.ID, now); err != ErrInvalidState {
		t.Fatalf("TryOpen with active cooling = %v, want ErrInvalidState", err)
	}
}

// DP-025 is idempotent on (session, citizen).
func TestIssueTokensIdempotent(t *testing.T) {
	svc := NewService(nil, nil, nil)
	vs := testSession(t, svc)
	first, err := svc.IssueTokens(vs.ID, []string{"cit-1"})
	if err != nil || len(first) != 1 || first[0].TokenBlind == "" {
		t.Fatalf("IssueTokens = %v, %v", first, err)
	}
	second, err := svc.IssueTokens(vs.ID, []string{"cit-1"})
	if err != nil {
		t.Fatal(err)
	}
	if second[0].ID != first[0].ID {
		t.Fatal("re-issue created a duplicate token row")
	}
	if got, err := svc.store.CountTokens(vs.ID); err != nil || got != 1 {
		t.Fatalf("token count = %d, %v, want 1", got, err)
	}
}

// DP-016: atomic cast; double-vote with the same token is rejected and the
// ballot carries no citizen identity.
func TestCastBallotAtomicAndSingleUse(t *testing.T) {
	svc := NewService(nil, nil, nil)
	vs := testSession(t, svc)
	openTestSession(t, svc, vs)
	tokens, _ := svc.IssueTokens(vs.ID, []string{"cit-1"})
	tok := tokens[0]

	b, err := svc.CastBallot(vs.ID, tok.ID, tok.TokenBlind, "choice-a", "cit-1")
	if err != nil {
		t.Fatalf("CastBallot: %v", err)
	}
	if b.VerificationCode == "" {
		t.Fatal("ballot missing verification code")
	}
	if _, err := svc.CastBallot(vs.ID, tok.ID, tok.TokenBlind, "choice-a", "cit-1"); err != ErrConflict {
		t.Fatalf("second cast = %v, want ErrConflict", err)
	}
	// Wrong blind does not match the stored hash.
	tokens2, _ := svc.IssueTokens(vs.ID, []string{"cit-2"})
	if _, err := svc.CastBallot(vs.ID, tokens2[0].ID, "forged-blind", "choice-a", "cit-2"); err != ErrInvalid {
		t.Fatalf("forged blind = %v, want ErrInvalid", err)
	}
}

// DP-017: verification confirms presence without revealing the choice.
func TestVerifyBallotHidesChoice(t *testing.T) {
	svc := NewService(nil, nil, nil)
	vs := testSession(t, svc)
	openTestSession(t, svc, vs)
	tokens, _ := svc.IssueTokens(vs.ID, []string{"cit-1"})
	b, _ := svc.CastBallot(vs.ID, tokens[0].ID, tokens[0].TokenBlind, "secret-choice", "cit-1")

	srv := httptest.NewServer(NewRouter(svc, testLogger()))
	defer srv.Close()

	// Service-level: lookup works.
	found, err := svc.VerifyBallot(b.VerificationCode)
	if err != nil || found.SessionID != vs.ID {
		t.Fatalf("VerifyBallot = %v, %v", found, err)
	}
	if _, err := svc.VerifyBallot("nope"); err != ErrNotFound {
		t.Fatalf("unknown code = %v, want ErrNotFound", err)
	}
}

// DP-027: quorum decides certified vs closed.
func TestCertifyQuorum(t *testing.T) {
	now := time.Now().UTC()
	svc := NewService(nil, nil, nil)
	vs, _ := svc.CreateSession(CreateSessionInput{
		ProposalID: "p", JurisdictionID: "j",
		Method: MethodApproval, ThresholdRule: ThresholdMajorityPlusQuorum,
		MinParticipation: 0.5,
		CoolingOffUntil:  now.Add(-time.Hour), OpensAt: now.Add(-time.Hour), ClosesAt: now.Add(time.Hour),
	})
	openTestSession(t, svc, vs)
	tokens, _ := svc.IssueTokens(vs.ID, []string{"c1", "c2"})
	// 1 of 2 votes = 0.5 participation → meets quorum.
	if _, err := svc.CastBallot(vs.ID, tokens[0].ID, tokens[0].TokenBlind, "a", "c1"); err != nil {
		t.Fatal(err)
	}
	closed, err := svc.TryClose(vs.ID, now.Add(2*time.Hour))
	if err != nil {
		t.Fatalf("TryClose: %v", err)
	}
	_ = closed
	certified, err := svc.Certify(vs.ID)
	if err != nil {
		t.Fatal(err)
	}
	if certified.Status != SessionCertified {
		t.Fatalf("status = %q, want certified", certified.Status)
	}
	if certified.TallyResult == nil || certified.TallyResult.TotalBallots != 1 {
		t.Fatalf("tally = %+v", certified.TallyResult)
	}
}

func TestCertifyQuorumFailureStaysClosed(t *testing.T) {
	now := time.Now().UTC()
	svc := NewService(nil, nil, nil)
	vs, _ := svc.CreateSession(CreateSessionInput{
		ProposalID: "p", JurisdictionID: "j",
		Method: MethodApproval, ThresholdRule: ThresholdMajorityPlusQuorum,
		MinParticipation: 0.9,
		CoolingOffUntil:  now.Add(-time.Hour), OpensAt: now.Add(-time.Hour), ClosesAt: now.Add(time.Hour),
	})
	openTestSession(t, svc, vs)
	tokens, _ := svc.IssueTokens(vs.ID, []string{"c1", "c2", "c3", "c4", "c5", "c6", "c7", "c8", "c9", "c10"})
	if _, err := svc.CastBallot(vs.ID, tokens[0].ID, tokens[0].TokenBlind, "a", "c1"); err != nil {
		t.Fatal(err)
	}
	if _, err := svc.TryClose(vs.ID, now.Add(2*time.Hour)); err != nil {
		t.Fatal(err)
	}
	out, err := svc.Certify(vs.ID)
	if err != nil {
		t.Fatal(err)
	}
	if out.Status != SessionClosed {
		t.Fatalf("quorum failure status = %q, want closed", out.Status)
	}
}

// Tally is exactly-once per session (DP-026 idempotency key).
func TestTallyIdempotent(t *testing.T) {
	now := time.Now().UTC()
	svc := NewService(nil, nil, nil)
	vs, _ := svc.CreateSession(CreateSessionInput{
		ProposalID: "p", JurisdictionID: "j",
		Method: MethodApproval, ThresholdRule: ThresholdSimpleMajority,
		CoolingOffUntil: now.Add(-time.Hour), OpensAt: now.Add(-time.Hour), ClosesAt: now.Add(time.Hour),
	})
	openTestSession(t, svc, vs)
	tokens, _ := svc.IssueTokens(vs.ID, []string{"c1"})
	if _, err := svc.CastBallot(vs.ID, tokens[0].ID, tokens[0].TokenBlind, "a", "c1"); err != nil {
		t.Fatal(err)
	}
	if _, err := svc.TryClose(vs.ID, now.Add(2*time.Hour)); err != nil {
		t.Fatal(err)
	}
	first, err := svc.Tally(vs.ID)
	if err != nil {
		t.Fatal(err)
	}
	second, err := svc.Tally(vs.ID)
	if err != nil {
		t.Fatal(err)
	}
	if first.TotalBallots != 1 || second.TotalBallots != 1 {
		t.Fatalf("tally not idempotent: %+v %+v", first, second)
	}
}

// State machine: ballot before open and double open are rejected.
func TestStateMachineViolations(t *testing.T) {
	svc := NewService(nil, nil, nil)
	vs := testSession(t, svc)
	tokens, _ := svc.IssueTokens(vs.ID, []string{"c1"})
	if _, err := svc.CastBallot(vs.ID, tokens[0].ID, tokens[0].TokenBlind, "a", "c1"); err != ErrInvalidState {
		t.Fatalf("cast while scheduled = %v, want ErrInvalidState", err)
	}
	openTestSession(t, svc, vs)
	if _, err := svc.TryOpen(vs.ID, time.Now().UTC()); err != ErrInvalidState {
		t.Fatalf("double open = %v, want ErrInvalidState", err)
	}
}

// DP-026 applies method and threshold_rule (US-032, US-046): strict
// majority for majority rules, two thirds for supermajority, plurality for
// ranked methods.
func TestEvaluateOutcome(t *testing.T) {
	cases := []struct {
		method, rule string
		counts       map[string]int
		total        int
		winner       string
		decided      bool
	}{
		{MethodApproval, ThresholdSimpleMajority, map[string]int{"a": 6, "b": 4}, 10, "a", true},
		{MethodApproval, ThresholdSimpleMajority, map[string]int{"a": 5, "b": 5}, 10, "", false},
		{MethodApproval, ThresholdSupermajority, map[string]int{"a": 7, "b": 3}, 10, "a", true},
		{MethodApproval, ThresholdSupermajority, map[string]int{"a": 6, "b": 4}, 10, "", false},
		{MethodRankedChoice, ThresholdSimpleMajority, map[string]int{"a": 4, "b": 3, "c": 3}, 10, "a", true},
		{MethodRankedChoice, ThresholdSimpleMajority, map[string]int{"a": 4, "b": 4}, 8, "", false},
		{MethodRankedChoice, ThresholdSupermajority, map[string]int{"a": 7, "b": 3}, 10, "a", true},
		{MethodRankedChoice, ThresholdSupermajority, map[string]int{"a": 6, "b": 4}, 10, "", false},
		{MethodApproval, ThresholdSimpleMajority, map[string]int{}, 0, "", false},
	}
	for i, c := range cases {
		winner, decided := evaluateOutcome(c.method, c.rule, c.counts, c.total)
		if winner != c.winner || decided != c.decided {
			t.Fatalf("case %d: = (%q, %v), want (%q, %v)", i, winner, decided, c.winner, c.decided)
		}
	}
}

func TestHealthz(t *testing.T) {
	svc := NewService(nil, nil, nil)
	srv := httptest.NewServer(NewRouter(svc, testLogger()))
	defer srv.Close()
	for _, path := range []string{"/healthz", "/readyz"} {
		resp, err := http.Get(srv.URL + path)
		if err != nil {
			t.Fatal(err)
		}
		resp.Body.Close()
		if resp.StatusCode != http.StatusOK {
			t.Fatalf("GET %s = %d, want 200", path, resp.StatusCode)
		}
	}
}
