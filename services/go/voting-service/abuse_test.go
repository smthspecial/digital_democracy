package main

import (
	"fmt"
	"net/http"
	"testing"
	"time"
)

// ABUSE-VOTE-3/4 (.spec/technical/test-plans/tp-001.md, ARCH-016 EC-18): POST /voting/sessions/{id}/open
// takes eligible_citizen_ids directly from the request body and issues one
// eligibility token per entry, with no independent verification against
// jurisdiction-service (or any other authority) that those citizens are real,
// unique, or actually eligible for this session's jurisdiction. DP-025 says
// eligibility should be *read* from jurisdiction-service; the code accepts
// whatever list the caller supplies. This means whoever can call /open
// controls the electorate outright: they can stuff it with fabricated ids
// (ballot stuffing) or simply omit real ones (disenfranchisement) -- both are
// the same bug, demonstrated together below. There is no seam/interface at
// all standing between this handler and jurisdiction-service (unlike, say,
// delegation-service's CompetencyChecker, which at least has an interface
// with a permissive default) -- there is nothing to inject a "real" checker
// into, so this documents current behavior directly rather than a stub's
// default, per ARCH-009 §2.
func TestAbuseVote3And4OpenAcceptsFabricatedElectorateWithNoJurisdictionCheck(t *testing.T) {
	h := newTestRouter()
	now := time.Now().UTC()

	session := createTestSessionViaHTTP(t, h, "approval", "simple_majority", 0.5, now)
	sessionID := session["id"].(string)

	// A legitimate citizen who should be on the electorate for this
	// jurisdiction never appears in the list below -- disenfranchisement by
	// simple omission, indistinguishable from any other request shape.
	legitimateCitizen := "real-verified-resident-of-this-jurisdiction"

	// A ballot-stuffing attacker's fabricated electorate: ids with no
	// corresponding identity-service record, no jurisdiction-service
	// residency, nothing -- just strings the caller of /open invented.
	fabricated := make([]string, 0, 100)
	for i := 0; i < 100; i++ {
		fabricated = append(fabricated, fmt.Sprintf("fabricated-citizen-%d", i))
	}

	openRec := doJSON(t, h, http.MethodPost, "/voting/sessions/"+sessionID+"/open", map[string]any{
		"eligible_citizen_ids": fabricated,
	})
	if openRec.Code != http.StatusOK {
		t.Fatalf("open session with fabricated electorate: status = %d, body = %s (expected 200 -- this endpoint performs no eligibility check at all)", openRec.Code, openRec.Body.String())
	}

	var openResp struct {
		IssuedTokens []struct {
			CitizenID   string `json:"citizen_id"`
			TokenSecret string `json:"token_secret"`
		} `json:"issued_tokens"`
	}
	decodeBody(t, openRec, &openResp)

	if len(openResp.IssuedTokens) != len(fabricated) {
		t.Fatalf("issued %d tokens, want %d -- every fabricated id should receive a real, usable eligibility token", len(openResp.IssuedTokens), len(fabricated))
	}
	for _, tok := range openResp.IssuedTokens {
		if tok.CitizenID == legitimateCitizen {
			t.Fatalf("legitimate citizen unexpectedly received a token -- fixture error")
		}
	}

	// Prove the fabricated tokens are not decorative: one of them can
	// actually cast a real, counted ballot.
	optRec := doJSON(t, h, http.MethodPost, "/voting/sessions/"+sessionID+"/options", map[string]any{"label": "Option A"})
	var opt map[string]any
	decodeBody(t, optRec, &opt)

	castRec := doJSON(t, h, http.MethodPost, "/voting/ballots", map[string]any{
		"session_id":   sessionID,
		"token_secret": openResp.IssuedTokens[0].TokenSecret,
		"choice":       opt["id"],
	})
	if castRec.Code != http.StatusCreated {
		t.Fatalf("cast ballot with fabricated-citizen token: status = %d, body = %s", castRec.Code, castRec.Body.String())
	}

	// And the legitimate citizen, simply never listed, has no token at all
	// and cannot vote in their own jurisdiction's session -- the same gap,
	// from the other direction.
	deniedRec := doJSON(t, h, http.MethodPost, "/voting/ballots", map[string]any{
		"session_id":   sessionID,
		"token_secret": "not-a-real-token-because-" + legitimateCitizen + "-was-never-issued-one",
		"choice":       opt["id"],
	})
	if deniedRec.Code == http.StatusCreated {
		t.Fatalf("omitted citizen unexpectedly managed to cast a ballot -- fixture error")
	}
}
