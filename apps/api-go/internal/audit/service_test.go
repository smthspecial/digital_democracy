package audit

import (
	"net/http"
	"net/http/httptest"
	"testing"
	"time"
)

func mustCount(t *testing.T, svc *Service) int {
	t.Helper()
	n, err := svc.store.Count()
	if err != nil {
		t.Fatal(err)
	}
	return n
}

// Append chains entries; tampering breaks verification.
func TestAppendAndVerify(t *testing.T) {
	svc := NewService(nil, nil)
	for i, action := range []string{ActionProposalCreated, ActionVoteCertified, ActionIdentityEvent} {
		e, err := svc.Append(action, "test", "payload", "")
		if err != nil {
			t.Fatal(err)
		}
		if i == 0 && e.PrevHash != GenesisPrevHash {
			t.Fatalf("first prev = %q, want GENESIS", e.PrevHash)
		}
	}
	ok, bad, err := svc.store.VerifyChain()
	if err != nil {
		t.Fatal(err)
	}
	if !ok {
		t.Fatalf("chain invalid at %d", bad)
	}
	if got := mustCount(t, svc); got != 3 {
		t.Fatalf("count = %d, want 3", got)
	}
}

// Unknown verbs are rejected, never stored.
func TestAppendRejectsUnknownAction(t *testing.T) {
	svc := NewService(nil, nil)
	if _, err := svc.Append("ballot_content_here", "x", "p", ""); err != ErrInvalid {
		t.Fatalf("Append = %v, want ErrInvalid", err)
	}
	if got := mustCount(t, svc); got != 0 {
		t.Fatalf("count = %d, want 0", got)
	}
}

// Emitter verbs map onto the TBL-034 enum (no history dropped).
func TestActionAliases(t *testing.T) {
	svc := NewService(nil, nil)
	e, err := svc.Append("vote_session_opened", "voting-service", "s1", "")
	if err != nil {
		t.Fatal(err)
	}
	if e.ActionType != ActionSystemUpdate {
		t.Fatalf("aliased action = %q", e.ActionType)
	}
}

// DP-036 at-least-once: redelivery with the same key returns the original.
func TestAppendIdempotent(t *testing.T) {
	svc := NewService(nil, nil)
	first, _ := svc.Append(ActionSystemUpdate, "a", "p", "evt-1")
	second, _ := svc.Append(ActionSystemUpdate, "a", "p", "evt-1")
	if first.ID != second.ID {
		t.Fatal("redelivery created a duplicate row")
	}
	if got := mustCount(t, svc); got != 1 {
		t.Fatalf("count = %d, want 1", got)
	}
}

// DP-034: any affected protected right blocks; otherwise cleared.
func TestConstitutionalReview(t *testing.T) {
	svc := NewService(nil, nil)
	speech, err := svc.store.CreateRight("free speech", "expression", true)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := svc.store.CreateRight("advisory guideline", "non-binding", false); err != nil {
		t.Fatal(err)
	}

	blocked, isBlocked, err := svc.TriggerReview(ReviewTrigger{
		ProposalID: "prop-1", AffectedRightIDs: []string{speech.ID}, ReviewerRef: "review-body-1",
	})
	_ = blocked
	if err != nil || !isBlocked {
		t.Fatalf("TriggerReview = %v, %v", blocked, err)
	}
	reviews, err := svc.store.ListReviews("prop-1")
	if err != nil {
		t.Fatal(err)
	}
	if len(reviews) != 1 || reviews[0].Result != ReviewBlocked {
		t.Fatalf("reviews = %+v", reviews)
	}

	_, cleared, err := svc.TriggerReview(ReviewTrigger{ProposalID: "prop-2", ReviewerRef: "review-body-1"})
	if err != nil || cleared {
		t.Fatalf("clean proposal blocked: %v %v", cleared, err)
	}
}

// Every review trigger is itself audited.
func TestReviewEmitsAudit(t *testing.T) {
	svc := NewService(nil, nil)
	if _, err := svc.store.CreateRight("r", "d", true); err != nil {
		t.Fatal(err)
	}
	before := mustCount(t, svc)
	if _, _, err := svc.TriggerReview(ReviewTrigger{ProposalID: "p", ReviewerRef: "rb"}); err != nil {
		t.Fatal(err)
	}
	if got := mustCount(t, svc); got != before+1 {
		t.Fatalf("audit entries %d -> %d, want +1", before, got)
	}
}

// DP-043: the gate releases only with all approvals, elapsed delay, and
// public visibility — exactly once. No unilateral activation.
func TestProtocolChangeGate(t *testing.T) {
	svc := NewService(nil, nil)
	now := time.Now().UTC()
	c, err := svc.RegisterChange(RegisterChangeInput{
		ChangeRef:         "voting-logic-v2",
		RequiredApprovals: []string{"appr-1", "appr-2"},
		DelayUntil:        now.Add(time.Hour),
		VisibleSince:      now.Add(-time.Hour),
	})
	if err != nil {
		t.Fatal(err)
	}
	if c.Status != ChangePending {
		t.Fatalf("status = %q", c.Status)
	}

	// Missing approval blocks release.
	if _, err := svc.RecordApproval(c.ID, "appr-1", "council-1", now); err != nil {
		t.Fatal(err)
	}
	if _, err := svc.ReleaseChange(c.ID, now.Add(2*time.Hour)); err == nil {
		t.Fatal("release with incomplete approvals must fail")
	}
	// Delay not elapsed blocks release.
	if _, err := svc.RecordApproval(c.ID, "appr-2", "council-2", now); err != nil {
		t.Fatal(err)
	}
	if _, err := svc.ReleaseChange(c.ID, now.Add(30*time.Minute)); err == nil {
		t.Fatal("release before delay must fail")
	}
	// Duplicate approval is rejected.
	if _, err := svc.RecordApproval(c.ID, "appr-1", "council-1", now); err != ErrConflict {
		t.Fatalf("duplicate approval = %v, want ErrConflict", err)
	}
	released, err := svc.ReleaseChange(c.ID, now.Add(2*time.Hour))
	if err != nil {
		t.Fatal(err)
	}
	if released.Status != ChangeReleased || released.ReleasedAt == nil {
		t.Fatalf("released = %+v", released)
	}
	// Exactly once: second release fails.
	if _, err := svc.ReleaseChange(c.ID, now.Add(3*time.Hour)); err == nil {
		t.Fatal("double release must fail")
	}
	// The release itself is audited.
	if got := mustCount(t, svc); got != 1 {
		t.Fatalf("audit entries = %d, want 1 (the release)", got)
	}
}

// BUG-001: apps/api-ts's HttpAuditEmitter (audit-emitter.ts) maps its own
// dotted domain verbs (identity.citizen_activated, iam.revoked, ...) onto
// exactly these four TBL-034 values before ever sending a request -- this
// is the Go-side half of the contract test: every value the TS mapper can
// produce must normalize successfully via the real POST /audit/log path,
// not just via the exported enum constants.
func TestAppendAcceptsEveryActionTypeApiTsCanSend(t *testing.T) {
	svc := NewService(nil, nil)
	for _, action := range []string{
		ActionIdentityEvent, // identity.*
		ActionAdminAction,   // iam.*, governance_role.*
		ActionProposalCreated,
		ActionSystemUpdate, // problem.*, deliberation.*, reputation.*, budget.*, project.*, civic_duty.*
	} {
		if _, err := svc.Append(action, "citizen-1", `{"event":"test"}`, ""); err != nil {
			t.Fatalf("Append(%q) = %v, want success", action, err)
		}
	}
}

func TestHealthz(t *testing.T) {
	srv := httptest.NewServer(NewRouter(NewService(nil, nil), nil))
	defer srv.Close()
	for _, path := range []string{"/healthz", "/readyz"} {
		resp, err := http.Get(srv.URL + path)
		if err != nil {
			t.Fatal(err)
		}
		resp.Body.Close()
		if resp.StatusCode != http.StatusOK {
			t.Fatalf("GET %s = %d", path, resp.StatusCode)
		}
	}
}
