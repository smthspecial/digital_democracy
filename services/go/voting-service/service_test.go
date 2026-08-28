package main

import (
	"errors"
	"sync"
	"testing"
	"time"
)

type fakeDelegationResolver struct {
	mu           sync.Mutex
	calls        []struct{ citizenID, domainID string }
	err          error
	delegatorIDs []string // returned by every call until reassigned
}

func (f *fakeDelegationResolver) ResolveDelegators(citizenID, domainID string) ([]string, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.calls = append(f.calls, struct{ citizenID, domainID string }{citizenID, domainID})
	if f.err != nil {
		return nil, f.err
	}
	return f.delegatorIDs, nil
}

type fakeAuditEmitter struct {
	mu     sync.Mutex
	events []struct{ eventType, payload string }
}

func (f *fakeAuditEmitter) Emit(eventType, payload string) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.events = append(f.events, struct{ eventType, payload string }{eventType, payload})
	return nil
}

func newTestService() (*Service, *fakeDelegationResolver, *fakeAuditEmitter) {
	res := &fakeDelegationResolver{}
	aud := &fakeAuditEmitter{}
	return NewService(res, aud), res, aud
}

func validCreateInput(now time.Time) CreateSessionInput {
	return CreateSessionInput{
		ProposalID:       "prop-1",
		JurisdictionID:   "juri-1",
		Method:           MethodApproval,
		ThresholdRule:    ThresholdSimpleMajority,
		MinParticipation: 0.5,
		CoolingOffUntil:  now.Add(-time.Hour),
		OpensAt:          now.Add(-time.Minute),
		ClosesAt:         now.Add(time.Hour),
	}
}

func TestCreateSessionValidation(t *testing.T) {
	now := time.Now().UTC()
	svc, _, _ := newTestService()

	cases := []struct {
		name    string
		mutate  func(in CreateSessionInput) CreateSessionInput
		wantErr bool
	}{
		{"valid", func(in CreateSessionInput) CreateSessionInput { return in }, false},
		{"invalid method", func(in CreateSessionInput) CreateSessionInput {
			in.Method = "not-a-method"
			return in
		}, true},
		{"invalid threshold rule", func(in CreateSessionInput) CreateSessionInput {
			in.ThresholdRule = "not-a-rule"
			return in
		}, true},
		{"min_participation zero", func(in CreateSessionInput) CreateSessionInput {
			in.MinParticipation = 0
			return in
		}, true},
		{"min_participation over one", func(in CreateSessionInput) CreateSessionInput {
			in.MinParticipation = 1.1
			return in
		}, true},
		{"min_participation exactly one is valid", func(in CreateSessionInput) CreateSessionInput {
			in.MinParticipation = 1.0
			return in
		}, false},
		{"closes_at before opens_at", func(in CreateSessionInput) CreateSessionInput {
			in.ClosesAt = in.OpensAt.Add(-time.Hour)
			return in
		}, true},
		{"closes_at equal opens_at", func(in CreateSessionInput) CreateSessionInput {
			in.ClosesAt = in.OpensAt
			return in
		}, true},
		{"opens_at before cooling_off_until", func(in CreateSessionInput) CreateSessionInput {
			in.OpensAt = in.CoolingOffUntil.Add(-time.Minute)
			return in
		}, true},
		{"missing proposal_id", func(in CreateSessionInput) CreateSessionInput {
			in.ProposalID = ""
			return in
		}, true},
		{"missing jurisdiction_id", func(in CreateSessionInput) CreateSessionInput {
			in.JurisdictionID = ""
			return in
		}, true},
	}

	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			input := c.mutate(validCreateInput(now))
			session, err := svc.CreateSession(input)
			if c.wantErr {
				if err == nil {
					t.Fatal("expected an error")
				}
				if !errors.Is(err, ErrValidation) {
					t.Fatalf("err = %v, want ErrValidation", err)
				}
				return
			}
			if err != nil {
				t.Fatalf("unexpected error: %v", err)
			}
			if session.Status != StatusScheduled {
				t.Fatalf("status = %q, want scheduled", session.Status)
			}
			if session.ID == "" {
				t.Fatal("expected a generated session ID")
			}
		})
	}
}

func TestAddOptionOnlyWhileScheduled(t *testing.T) {
	svc, _, _ := newTestService()
	now := time.Now().UTC()
	session, err := svc.CreateSession(validCreateInput(now))
	if err != nil {
		t.Fatalf("CreateSession: %v", err)
	}

	opt, err := svc.AddOption(session.ID, AddOptionInput{Label: "Option A"})
	if err != nil {
		t.Fatalf("AddOption: %v", err)
	}
	if opt.VoteSessionID != session.ID {
		t.Fatalf("VoteSessionID = %q, want %q", opt.VoteSessionID, session.ID)
	}

	if err := svc.TransitionOpen(session.ID, now); err != nil {
		t.Fatalf("TransitionOpen: %v", err)
	}

	if _, err := svc.AddOption(session.ID, AddOptionInput{Label: "Too late"}); !errors.Is(err, ErrSessionNotScheduled) {
		t.Fatalf("err = %v, want ErrSessionNotScheduled", err)
	}
}

func TestAddOptionUnknownSession(t *testing.T) {
	svc, _, _ := newTestService()
	if _, err := svc.AddOption("no-such-session", AddOptionInput{Label: "x"}); !errors.Is(err, ErrSessionNotFound) {
		t.Fatalf("err = %v, want ErrSessionNotFound", err)
	}
}

func TestTransitionOpenPreconditions(t *testing.T) {
	svc, _, _ := newTestService()
	now := time.Now().UTC()

	notYetOpen, err := svc.CreateSession(CreateSessionInput{
		ProposalID: "p", JurisdictionID: "j", Method: MethodApproval, ThresholdRule: ThresholdSimpleMajority,
		MinParticipation: 0.5, CoolingOffUntil: now.Add(-time.Hour), OpensAt: now.Add(time.Hour), ClosesAt: now.Add(2 * time.Hour),
	})
	if err != nil {
		t.Fatalf("CreateSession: %v", err)
	}
	if err := svc.TransitionOpen(notYetOpen.ID, now); !errors.Is(err, ErrOpenPreconditionFailed) {
		t.Fatalf("err = %v, want ErrOpenPreconditionFailed (opens_at not reached)", err)
	}

	coolingOff, err := svc.CreateSession(CreateSessionInput{
		ProposalID: "p", JurisdictionID: "j", Method: MethodApproval, ThresholdRule: ThresholdSimpleMajority,
		MinParticipation: 0.5, CoolingOffUntil: now.Add(time.Hour), OpensAt: now.Add(time.Hour), ClosesAt: now.Add(2 * time.Hour),
	})
	if err != nil {
		t.Fatalf("CreateSession: %v", err)
	}
	if err := svc.TransitionOpen(coolingOff.ID, now); !errors.Is(err, ErrOpenPreconditionFailed) {
		t.Fatalf("err = %v, want ErrOpenPreconditionFailed (cooling off)", err)
	}

	ready, err := svc.CreateSession(validCreateInput(now))
	if err != nil {
		t.Fatalf("CreateSession: %v", err)
	}
	if err := svc.TransitionOpen(ready.ID, now); err != nil {
		t.Fatalf("TransitionOpen: %v", err)
	}
	got, err := svc.GetSession(ready.ID)
	if err != nil {
		t.Fatalf("GetSession: %v", err)
	}
	if got.Status != StatusOpen {
		t.Fatalf("status = %q, want open", got.Status)
	}

	if err := svc.TransitionOpen(ready.ID, now); !errors.Is(err, ErrSessionNotScheduled) {
		t.Fatalf("err = %v, want ErrSessionNotScheduled (already open)", err)
	}
}

func TestIssueEligibilityTokensIdempotent(t *testing.T) {
	svc, _, _ := newTestService()
	now := time.Now().UTC()
	session, err := svc.CreateSession(validCreateInput(now))
	if err != nil {
		t.Fatalf("CreateSession: %v", err)
	}
	if err := svc.TransitionOpen(session.ID, now); err != nil {
		t.Fatalf("TransitionOpen: %v", err)
	}

	issued, err := svc.IssueEligibilityTokens(session.ID, []string{"citizen-1", "citizen-2"})
	if err != nil {
		t.Fatalf("IssueEligibilityTokens: %v", err)
	}
	if len(issued) != 2 {
		t.Fatalf("issued = %d, want 2", len(issued))
	}
	for _, it := range issued {
		if it.TokenSecret == "" {
			t.Fatal("expected a non-empty token secret")
		}
	}

	// Re-issuing to citizen-1 plus a new citizen-3: only citizen-3 should
	// appear in the result.
	issued2, err := svc.IssueEligibilityTokens(session.ID, []string{"citizen-1", "citizen-3"})
	if err != nil {
		t.Fatalf("IssueEligibilityTokens (round 2): %v", err)
	}
	if len(issued2) != 1 {
		t.Fatalf("issued2 = %d, want 1", len(issued2))
	}
	if issued2[0].CitizenID != "citizen-3" {
		t.Fatalf("issued2[0].CitizenID = %q, want citizen-3", issued2[0].CitizenID)
	}
}

func TestCastBallotFullFlowAndDelegationResolver(t *testing.T) {
	svc, resolver, _ := newTestService()
	now := time.Now().UTC()
	session, err := svc.CreateSession(validCreateInput(now))
	if err != nil {
		t.Fatalf("CreateSession: %v", err)
	}
	if _, err := svc.AddOption(session.ID, AddOptionInput{Label: "A"}); err != nil {
		t.Fatalf("AddOption: %v", err)
	}
	if err := svc.TransitionOpen(session.ID, now); err != nil {
		t.Fatalf("TransitionOpen: %v", err)
	}
	issued, err := svc.IssueEligibilityTokens(session.ID, []string{"citizen-1"})
	if err != nil {
		t.Fatalf("IssueEligibilityTokens: %v", err)
	}

	ballot, err := svc.CastBallot(session.ID, issued[0].TokenSecret, "opt1", now)
	if err != nil {
		t.Fatalf("CastBallot: %v", err)
	}
	if ballot.VerificationCode == "" {
		t.Fatal("expected a non-empty verification code")
	}

	resolver.mu.Lock()
	defer resolver.mu.Unlock()
	if len(resolver.calls) != 1 {
		t.Fatalf("resolver calls = %d, want 1", len(resolver.calls))
	}
	if resolver.calls[0].citizenID != "citizen-1" {
		t.Fatalf("resolver citizenID = %q, want citizen-1", resolver.calls[0].citizenID)
	}
	if resolver.calls[0].domainID != session.ProposalID {
		t.Fatalf("resolver domainID = %q, want %q", resolver.calls[0].domainID, session.ProposalID)
	}
}

func TestCastBallotAppliesDelegationWeight(t *testing.T) {
	svc, resolver, _ := newTestService()
	resolver.delegatorIDs = []string{"citizen-2"}
	now := time.Now().UTC()
	session, err := svc.CreateSession(validCreateInput(now))
	if err != nil {
		t.Fatalf("CreateSession: %v", err)
	}
	if err := svc.TransitionOpen(session.ID, now); err != nil {
		t.Fatalf("TransitionOpen: %v", err)
	}
	issued, err := svc.IssueEligibilityTokens(session.ID, []string{"citizen-1"})
	if err != nil {
		t.Fatalf("IssueEligibilityTokens: %v", err)
	}

	ballot, err := svc.CastBallot(session.ID, issued[0].TokenSecret, "opt1", now)
	if err != nil {
		t.Fatalf("CastBallot: %v", err)
	}
	if ballot.Weight != 2 {
		t.Fatalf("ballot.Weight = %d, want 2 (citizen-1 plus resolved delegator citizen-2)", ballot.Weight)
	}
}

// TestCloseSessionCountsDelegatedVotes is the DP-041 regression this fix
// closes: before it, a delegate's ballot always counted as exactly one
// vote no matter how many citizens had delegated to them, so a delegated
// majority could lose a tally it should have won.
func TestCloseSessionCountsDelegatedVotes(t *testing.T) {
	svc, resolver, _ := newTestService()
	now := time.Now().UTC()
	session, err := svc.CreateSession(CreateSessionInput{
		ProposalID: "p", JurisdictionID: "j", Method: MethodApproval, ThresholdRule: ThresholdSimpleMajority,
		MinParticipation: 1, CoolingOffUntil: now.Add(-time.Hour), OpensAt: now.Add(-time.Minute), ClosesAt: now.Add(time.Minute),
	})
	if err != nil {
		t.Fatalf("CreateSession: %v", err)
	}
	optA, err := svc.AddOption(session.ID, AddOptionInput{Label: "A"})
	if err != nil {
		t.Fatalf("AddOption A: %v", err)
	}
	optB, err := svc.AddOption(session.ID, AddOptionInput{Label: "B"})
	if err != nil {
		t.Fatalf("AddOption B: %v", err)
	}
	if err := svc.TransitionOpen(session.ID, now); err != nil {
		t.Fatalf("TransitionOpen: %v", err)
	}
	secrets := issueTokensMap(t, svc, session.ID, []string{"citizen-delegate", "citizen-direct-1", "citizen-direct-2"})

	// citizen-delegate votes A and carries two delegators' worth of weight
	// (three total votes for A, since weight = 1 + len(delegators)); two
	// other citizens vote B directly (two votes for B). Without weighting,
	// A and B would tie 1-2 and B would win the lexicographic tiebreak;
	// with weighting, A must win 3-2.
	resolver.delegatorIDs = []string{"citizen-delegator-1", "citizen-delegator-2"}
	castApprovalBallot(t, svc, session.ID, secrets["citizen-delegate"], optA.ID, now)
	resolver.delegatorIDs = nil
	castApprovalBallot(t, svc, session.ID, secrets["citizen-direct-1"], optB.ID, now)
	castApprovalBallot(t, svc, session.ID, secrets["citizen-direct-2"], optB.ID, now)

	closed, err := svc.CloseSession(session.ID, now.Add(2*time.Minute))
	if err != nil {
		t.Fatalf("CloseSession: %v", err)
	}
	if closed.Status != StatusCertified {
		t.Fatalf("status = %q, want certified", closed.Status)
	}

	tally, err := svc.GetTally(session.ID)
	if err != nil {
		t.Fatalf("GetTally: %v", err)
	}
	if tally.WinnerOptionID == nil || *tally.WinnerOptionID != optA.ID {
		t.Fatalf("winner = %v, want %v (A should win 3-2 once the delegated vote is weighted)", tally.WinnerOptionID, optA.ID)
	}
	if tally.Counts[optA.ID] != 3 {
		t.Fatalf("counts[A] = %v, want 3 (one delegate ballot replayed at weight 3)", tally.Counts[optA.ID])
	}
	if tally.Counts[optB.ID] != 2 {
		t.Fatalf("counts[B] = %v, want 2 (two direct ballots at weight 1 each)", tally.Counts[optB.ID])
	}
	if tally.TotalBallots != 3 {
		t.Fatalf("TotalBallots = %d, want 3 actual ballots cast (weighting must not inflate this field)", tally.TotalBallots)
	}
}

func TestCastBallotResolverErrorDoesNotRollBackBallot(t *testing.T) {
	svc, resolver, _ := newTestService()
	resolver.err = errors.New("delegation-service unreachable")
	now := time.Now().UTC()
	session, err := svc.CreateSession(validCreateInput(now))
	if err != nil {
		t.Fatalf("CreateSession: %v", err)
	}
	if err := svc.TransitionOpen(session.ID, now); err != nil {
		t.Fatalf("TransitionOpen: %v", err)
	}
	issued, err := svc.IssueEligibilityTokens(session.ID, []string{"citizen-1"})
	if err != nil {
		t.Fatalf("IssueEligibilityTokens: %v", err)
	}

	ballot, err := svc.CastBallot(session.ID, issued[0].TokenSecret, "opt1", now)
	if err != nil {
		t.Fatalf("CastBallot must still succeed despite resolver error: %v", err)
	}
	if ballot == nil {
		t.Fatal("expected a committed ballot")
	}
}

func TestCastBallotErrors(t *testing.T) {
	svc, _, _ := newTestService()
	now := time.Now().UTC()
	session, err := svc.CreateSession(validCreateInput(now))
	if err != nil {
		t.Fatalf("CreateSession: %v", err)
	}

	if _, err := svc.CastBallot(session.ID, "no-token", "opt1", now); !errors.Is(err, ErrSessionNotOpen) {
		t.Fatalf("err = %v, want ErrSessionNotOpen (session still scheduled)", err)
	}

	if err := svc.TransitionOpen(session.ID, now); err != nil {
		t.Fatalf("TransitionOpen: %v", err)
	}
	if _, err := svc.CastBallot(session.ID, "no-such-token", "opt1", now); !errors.Is(err, ErrTokenNotFound) {
		t.Fatalf("err = %v, want ErrTokenNotFound", err)
	}

	issued, err := svc.IssueEligibilityTokens(session.ID, []string{"citizen-1"})
	if err != nil {
		t.Fatalf("IssueEligibilityTokens: %v", err)
	}
	if _, err := svc.CastBallot(session.ID, issued[0].TokenSecret, "opt1", now); err != nil {
		t.Fatalf("first CastBallot: %v", err)
	}
	if _, err := svc.CastBallot(session.ID, issued[0].TokenSecret, "opt1", now); !errors.Is(err, ErrTokenUsed) {
		t.Fatalf("err = %v, want ErrTokenUsed", err)
	}
}

func TestVerifyBallotInclusion(t *testing.T) {
	svc, _, _ := newTestService()
	now := time.Now().UTC()
	session, err := svc.CreateSession(validCreateInput(now))
	if err != nil {
		t.Fatalf("CreateSession: %v", err)
	}
	if err := svc.TransitionOpen(session.ID, now); err != nil {
		t.Fatalf("TransitionOpen: %v", err)
	}
	issued, err := svc.IssueEligibilityTokens(session.ID, []string{"citizen-1"})
	if err != nil {
		t.Fatalf("IssueEligibilityTokens: %v", err)
	}
	ballot, err := svc.CastBallot(session.ID, issued[0].TokenSecret, "opt1", now)
	if err != nil {
		t.Fatalf("CastBallot: %v", err)
	}

	found, err := svc.VerifyBallotInclusion(session.ID, ballot.VerificationCode)
	if err != nil {
		t.Fatalf("VerifyBallotInclusion: %v", err)
	}
	if !found {
		t.Fatal("expected ballot to be found")
	}

	notFound, err := svc.VerifyBallotInclusion(session.ID, "0000dead")
	if err != nil {
		t.Fatalf("VerifyBallotInclusion: %v", err)
	}
	if notFound {
		t.Fatal("expected no match for an unused code")
	}

	if _, err := svc.VerifyBallotInclusion("no-such-session", "0000dead"); !errors.Is(err, ErrSessionNotFound) {
		t.Fatalf("err = %v, want ErrSessionNotFound", err)
	}
}

func issueTokensMap(t *testing.T, svc *Service, sessionID string, citizenIDs []string) map[string]string {
	t.Helper()
	issued, err := svc.IssueEligibilityTokens(sessionID, citizenIDs)
	if err != nil {
		t.Fatalf("IssueEligibilityTokens: %v", err)
	}
	m := make(map[string]string, len(issued))
	for _, it := range issued {
		m[it.CitizenID] = it.TokenSecret
	}
	return m
}

func castApprovalBallot(t *testing.T, svc *Service, sessionID, tokenSecret, choice string, now time.Time) {
	t.Helper()
	if _, err := svc.CastBallot(sessionID, tokenSecret, choice, now); err != nil {
		t.Fatalf("CastBallot: %v", err)
	}
}

func TestCloseSessionQuorumMetCertifiesAndEmitsAudit(t *testing.T) {
	svc, _, audit := newTestService()
	now := time.Now().UTC()
	session, err := svc.CreateSession(CreateSessionInput{
		ProposalID: "p", JurisdictionID: "j", Method: MethodApproval, ThresholdRule: ThresholdSimpleMajority,
		MinParticipation: 0.5, CoolingOffUntil: now.Add(-time.Hour), OpensAt: now.Add(-time.Minute), ClosesAt: now.Add(time.Minute),
	})
	if err != nil {
		t.Fatalf("CreateSession: %v", err)
	}
	opt, err := svc.AddOption(session.ID, AddOptionInput{Label: "A"})
	if err != nil {
		t.Fatalf("AddOption: %v", err)
	}
	if err := svc.TransitionOpen(session.ID, now); err != nil {
		t.Fatalf("TransitionOpen: %v", err)
	}
	secrets := issueTokensMap(t, svc, session.ID, []string{"citizen-1", "citizen-2"})
	castApprovalBallot(t, svc, session.ID, secrets["citizen-1"], opt.ID, now)
	castApprovalBallot(t, svc, session.ID, secrets["citizen-2"], opt.ID, now)

	closed, err := svc.CloseSession(session.ID, now.Add(2*time.Minute))
	if err != nil {
		t.Fatalf("CloseSession: %v", err)
	}
	if closed.Status != StatusCertified {
		t.Fatalf("status = %q, want certified", closed.Status)
	}

	tally, err := svc.GetTally(session.ID)
	if err != nil {
		t.Fatalf("GetTally: %v", err)
	}
	if !tally.QuorumMet {
		t.Fatal("expected quorum_met=true")
	}
	if tally.WinnerOptionID == nil || *tally.WinnerOptionID != opt.ID {
		t.Fatalf("winner = %v, want %v", tally.WinnerOptionID, opt.ID)
	}
	if tally.CertifiedAt == nil {
		t.Fatal("expected CertifiedAt to be set")
	}

	audit.mu.Lock()
	defer audit.mu.Unlock()
	if len(audit.events) != 1 {
		t.Fatalf("audit events = %d, want exactly 1", len(audit.events))
	}
}

func TestCloseSessionQuorumNotMetStaysClosedNoAudit(t *testing.T) {
	svc, _, audit := newTestService()
	now := time.Now().UTC()
	session, err := svc.CreateSession(CreateSessionInput{
		ProposalID: "p", JurisdictionID: "j", Method: MethodApproval, ThresholdRule: ThresholdSimpleMajority,
		MinParticipation: 0.9, CoolingOffUntil: now.Add(-time.Hour), OpensAt: now.Add(-time.Minute), ClosesAt: now.Add(time.Minute),
	})
	if err != nil {
		t.Fatalf("CreateSession: %v", err)
	}
	opt, err := svc.AddOption(session.ID, AddOptionInput{Label: "A"})
	if err != nil {
		t.Fatalf("AddOption: %v", err)
	}
	if err := svc.TransitionOpen(session.ID, now); err != nil {
		t.Fatalf("TransitionOpen: %v", err)
	}
	secrets := issueTokensMap(t, svc, session.ID, []string{"citizen-1", "citizen-2", "citizen-3", "citizen-4"})
	castApprovalBallot(t, svc, session.ID, secrets["citizen-1"], opt.ID, now)

	closed, err := svc.CloseSession(session.ID, now.Add(2*time.Minute))
	if err != nil {
		t.Fatalf("CloseSession: %v", err)
	}
	if closed.Status != StatusClosed {
		t.Fatalf("status = %q, want closed (quorum failed)", closed.Status)
	}

	tally, err := svc.GetTally(session.ID)
	if err != nil {
		t.Fatalf("GetTally: %v", err)
	}
	if tally.QuorumMet {
		t.Fatal("expected quorum_met=false")
	}
	if tally.CertifiedAt != nil {
		t.Fatal("expected CertifiedAt to be nil when quorum fails")
	}

	audit.mu.Lock()
	defer audit.mu.Unlock()
	if len(audit.events) != 0 {
		t.Fatalf("audit events = %d, want 0 (no certification)", len(audit.events))
	}
}

func TestCloseSessionSupermajorityRejectsInsufficientWinner(t *testing.T) {
	svc, _, _ := newTestService()
	now := time.Now().UTC()
	session, err := svc.CreateSession(CreateSessionInput{
		ProposalID: "p", JurisdictionID: "j", Method: MethodApproval, ThresholdRule: ThresholdSupermajority,
		MinParticipation: 0.5, CoolingOffUntil: now.Add(-time.Hour), OpensAt: now.Add(-time.Minute), ClosesAt: now.Add(time.Minute),
	})
	if err != nil {
		t.Fatalf("CreateSession: %v", err)
	}
	opt, err := svc.AddOption(session.ID, AddOptionInput{Label: "A"})
	if err != nil {
		t.Fatalf("AddOption: %v", err)
	}
	if err := svc.TransitionOpen(session.ID, now); err != nil {
		t.Fatalf("TransitionOpen: %v", err)
	}
	// opt approved by 2 of 4 ballots = 50% < 2/3 supermajority threshold.
	secrets := issueTokensMap(t, svc, session.ID, []string{"citizen-1", "citizen-2", "citizen-3", "citizen-4"})
	castApprovalBallot(t, svc, session.ID, secrets["citizen-1"], opt.ID, now)
	castApprovalBallot(t, svc, session.ID, secrets["citizen-2"], opt.ID, now)
	castApprovalBallot(t, svc, session.ID, secrets["citizen-3"], "", now)
	castApprovalBallot(t, svc, session.ID, secrets["citizen-4"], "", now)

	closed, err := svc.CloseSession(session.ID, now.Add(2*time.Minute))
	if err != nil {
		t.Fatalf("CloseSession: %v", err)
	}
	tally, err := svc.GetTally(session.ID)
	if err != nil {
		t.Fatalf("GetTally: %v", err)
	}
	if tally.WinnerOptionID != nil {
		t.Fatalf("winner = %v, want nil (supermajority not met)", *tally.WinnerOptionID)
	}
	_ = closed
}

func TestCloseSessionSupermajorityAcceptsSufficientWinner(t *testing.T) {
	svc, _, _ := newTestService()
	now := time.Now().UTC()
	session, err := svc.CreateSession(CreateSessionInput{
		ProposalID: "p", JurisdictionID: "j", Method: MethodApproval, ThresholdRule: ThresholdSupermajority,
		MinParticipation: 0.5, CoolingOffUntil: now.Add(-time.Hour), OpensAt: now.Add(-time.Minute), ClosesAt: now.Add(time.Minute),
	})
	if err != nil {
		t.Fatalf("CreateSession: %v", err)
	}
	opt, err := svc.AddOption(session.ID, AddOptionInput{Label: "A"})
	if err != nil {
		t.Fatalf("AddOption: %v", err)
	}
	if err := svc.TransitionOpen(session.ID, now); err != nil {
		t.Fatalf("TransitionOpen: %v", err)
	}
	secrets := issueTokensMap(t, svc, session.ID, []string{"citizen-1", "citizen-2", "citizen-3"})
	castApprovalBallot(t, svc, session.ID, secrets["citizen-1"], opt.ID, now)
	castApprovalBallot(t, svc, session.ID, secrets["citizen-2"], opt.ID, now)
	castApprovalBallot(t, svc, session.ID, secrets["citizen-3"], opt.ID, now)

	if _, err := svc.CloseSession(session.ID, now.Add(2*time.Minute)); err != nil {
		t.Fatalf("CloseSession: %v", err)
	}
	tally, err := svc.GetTally(session.ID)
	if err != nil {
		t.Fatalf("GetTally: %v", err)
	}
	if tally.WinnerOptionID == nil || *tally.WinnerOptionID != opt.ID {
		t.Fatalf("winner = %v, want %v", tally.WinnerOptionID, opt.ID)
	}
}

func TestCloseSessionPreconditions(t *testing.T) {
	svc, _, _ := newTestService()
	now := time.Now().UTC()
	session, err := svc.CreateSession(validCreateInput(now))
	if err != nil {
		t.Fatalf("CreateSession: %v", err)
	}
	if _, err := svc.CloseSession(session.ID, now); !errors.Is(err, ErrSessionNotOpen) {
		t.Fatalf("err = %v, want ErrSessionNotOpen (still scheduled)", err)
	}

	if err := svc.TransitionOpen(session.ID, now); err != nil {
		t.Fatalf("TransitionOpen: %v", err)
	}
	if _, err := svc.CloseSession(session.ID, now); !errors.Is(err, ErrCloseNotEligible) {
		t.Fatalf("err = %v, want ErrCloseNotEligible (closes_at not reached)", err)
	}
}

func TestGetTallyBeforeCloseErrors(t *testing.T) {
	svc, _, _ := newTestService()
	now := time.Now().UTC()
	session, err := svc.CreateSession(validCreateInput(now))
	if err != nil {
		t.Fatalf("CreateSession: %v", err)
	}
	if _, err := svc.GetTally(session.ID); !errors.Is(err, ErrTallyNotAvailable) {
		t.Fatalf("err = %v, want ErrTallyNotAvailable", err)
	}
}

func TestListOptionsPreservesInsertionOrder(t *testing.T) {
	svc, _, _ := newTestService()
	now := time.Now().UTC()
	session, err := svc.CreateSession(validCreateInput(now))
	if err != nil {
		t.Fatalf("CreateSession: %v", err)
	}
	labels := []string{"First", "Second", "Third"}
	for _, l := range labels {
		if _, err := svc.AddOption(session.ID, AddOptionInput{Label: l}); err != nil {
			t.Fatalf("AddOption: %v", err)
		}
	}
	opts, err := svc.ListOptions(session.ID)
	if err != nil {
		t.Fatalf("ListOptions: %v", err)
	}
	if len(opts) != 3 {
		t.Fatalf("got %d options, want 3", len(opts))
	}
	for i, l := range labels {
		if opts[i].Label != l {
			t.Fatalf("opts[%d].Label = %q, want %q", i, opts[i].Label, l)
		}
	}
}
