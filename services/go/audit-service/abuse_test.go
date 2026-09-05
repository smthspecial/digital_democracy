package main

import (
	"encoding/json"
	"net/http"
	"testing"
)

// ABUSE-AUDIT-1 (.spec/technical/test-plans/tp-001.md, ARCH-021 EC-52): POST /audit/log has no
// caller authentication at all -- actor_ref is a self-declared string, never
// checked against who is actually making the HTTP request. The hash chain
// (chain.go) proves *sequence* integrity (each entry's prev_hash links to
// the one before it, tamper anywhere breaks verify from that point on) but
// says nothing about *authorship*: a forged entry, correctly chained, is
// indistinguishable from a real one at the storage layer. This test forges
// an entry claiming to be voting-service reporting a vote_certified event it
// never actually certified, and shows it is accepted and the chain still
// reports valid=true -- proving the chain's guarantee is narrower than
// "nothing false was ever recorded here".
func TestAbuseAudit1ForgedActorRefPassesChainVerification(t *testing.T) {
	h := newTestRouter()

	// A real entry, as if from a real service.
	real := doJSON(t, h, http.MethodPost, "/audit/log", map[string]any{
		"action_type": "system_update",
		"actor_ref":   "audit-service-internal",
		"payload":     map[string]any{"note": "genuine boot event"},
	})
	if real.Code != http.StatusCreated {
		t.Fatalf("genuine entry: status = %d, body = %s", real.Code, real.Body.String())
	}

	// A forged entry: any caller can claim to be voting-service and report a
	// vote certification that never happened. Nothing here requires proving
	// the caller *is* voting-service.
	forged := doJSON(t, h, http.MethodPost, "/audit/log", map[string]any{
		"action_type": "vote_certified",
		"actor_ref":   "voting-service",
		"payload":     map[string]any{"session_id": "does-not-exist", "outcome": "approved"},
	})
	if forged.Code != http.StatusCreated {
		t.Fatalf("forged entry: status = %d, body = %s (expected 201 -- actor_ref is never verified)", forged.Code, forged.Body.String())
	}

	verifyRec := doJSON(t, h, http.MethodGet, "/audit/log/verify", nil)
	var verify struct {
		Valid    bool    `json:"valid"`
		BrokenAt *string `json:"broken_at"`
	}
	if err := json.Unmarshal(verifyRec.Body.Bytes(), &verify); err != nil {
		t.Fatalf("decode verify response: %v", err)
	}
	if !verify.Valid {
		t.Fatalf("expected the chain to still report valid=true with the forged entry included -- the chain proves sequence integrity, not authorship, and the forged entry is correctly linked")
	}

	listRec := doJSON(t, h, http.MethodGet, "/audit/log?action_type=vote_certified", nil)
	var listed struct {
		Entries []struct {
			ActorRef string `json:"actor_ref"`
		} `json:"entries"`
	}
	if err := json.Unmarshal(listRec.Body.Bytes(), &listed); err != nil {
		t.Fatalf("decode list response: %v", err)
	}
	found := false
	for _, e := range listed.Entries {
		if e.ActorRef == "voting-service" {
			found = true
		}
	}
	if !found {
		t.Fatalf("expected the forged voting-service entry to be listed alongside genuine entries, indistinguishable")
	}
}

// ABUSE-AUDIT-3 (.spec/technical/test-plans/tp-001.md, ARCH-021 EC-47): DP-034's constitutional
// review (service.go's keywordMatchAssessor) blocks a change only if the
// protected right's *literal name* (case-insensitive) appears as a substring
// of change_summary. TestServiceReviewProposalDefaultAssessorKeywordMatch
// (service_test.go) already proves the positive case (the literal name
// triggers a block) and an unrelated negative case (an unrelated summary
// doesn't). This test proves the adversarial middle case that matters for a
// real "criminal user" scenario: a change summary that plainly violates the
// right in substance, phrased to avoid the literal keyword, sails through
// uncaught.
func TestAbuseAudit3ConstitutionalReviewEvadedByRephrasing(t *testing.T) {
	svc := NewService(NewStore())
	if _, err := svc.CreateRight("freedom of speech", "protects expression", true); err != nil {
		t.Fatalf("create right: %v", err)
	}

	// Plainly a free-speech violation in substance -- a ban on public
	// expression -- but never uses the words "freedom" or "speech".
	evasiveSummary := "Citizens may no longer post public commentary criticizing elected officials on this platform."

	_, blocked, err := svc.ReviewProposal("proposal-evasive", evasiveSummary)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if blocked {
		t.Fatalf("did not expect the keyword-match assessor to catch a substantively-violating summary that avoids the literal right name -- if this now fails, the assessor has been made smarter than a keyword match and this test (and the finding it documents) should be revisited")
	}
}
