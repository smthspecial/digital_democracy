package main

import (
	"net/http"
	"testing"
	"time"
)

// ABUSE-IDOR-4 (testing/e2e-api-test-plan.md): DELETE /delegation/delegations/{id}
// authorizes a revoke by comparing the request body's requesting_citizen_id
// to the stored delegator_id -- a plain string equality check, not a real
// credential. delegator_id is not a secret: GET /delegation/delegations is
// public with no auth (by design, FR-056 transparency), so anyone can read
// it off that list and then simply assert it in a revoke call. This test
// walks that exact chain end to end: an "attacker" who is not alice reads
// alice's delegation off the public listing, then revokes it by supplying
// her id, and the service cannot tell the difference between that and a
// revoke alice genuinely issued herself. Contrast with
// TestRevokeDelegationNotOwner (service_test.go), which proves the id
// *comparison* itself is correct -- this test proves the comparison alone is
// not authentication, since the value being compared against is public.
func TestAbuseIDOR4RevokeAuthorizedByPubliclyReadableDelegatorID(t *testing.T) {
	svc, competency, _ := newTestService()
	competency.allow("bob", "healthcare")
	h := newTestRouter(svc)
	now := time.Now()

	delegatorID := "alice"
	created, err := svc.CreateDelegation(delegatorID, "bob", "healthcare", now.Add(24*time.Hour), now)
	if err != nil {
		t.Fatalf("unexpected error creating fixture delegation: %v", err)
	}

	// Step 1: the attacker, with no relationship to this delegation at all,
	// discovers delegatorID purely by reading the public list -- no session,
	// no credential, nothing that proves who is actually calling.
	listRec := doJSON(t, h, http.MethodGet, "/delegation/delegations?delegator_id="+delegatorID, nil)
	if listRec.Code != http.StatusOK {
		t.Fatalf("public list: status = %d, body = %s", listRec.Code, listRec.Body.String())
	}
	var listed struct {
		Delegations []struct {
			ID          string `json:"id"`
			DelegatorID string `json:"delegator_id"`
		} `json:"delegations"`
	}
	decodeBody(t, listRec, &listed)
	if len(listed.Delegations) != 1 || listed.Delegations[0].DelegatorID != delegatorID {
		t.Fatalf("fixture error: expected exactly one delegation with delegator_id=%s in the public listing, got %+v", delegatorID, listed.Delegations)
	}
	discoveredDelegatorID := listed.Delegations[0].DelegatorID

	// Step 2: the attacker revokes it, asserting the discovered id as their
	// own -- there is nothing in this request that actually establishes the
	// caller is alice.
	revokeRec := doJSON(t, h, http.MethodDelete, "/delegation/delegations/"+created.ID, map[string]any{
		"requesting_citizen_id": discoveredDelegatorID,
	})
	if revokeRec.Code != http.StatusOK {
		t.Fatalf("attacker's spoofed revoke: status = %d, body = %s (expected 200 -- requesting_citizen_id is a self-asserted string, not a verified credential)", revokeRec.Code, revokeRec.Body.String())
	}

	after, ok := svc.store.Get(created.ID)
	if !ok {
		t.Fatalf("expected delegation %s to still exist", created.ID)
	}
	if after.RevokedAt == nil {
		t.Fatalf("expected delegation to be revoked by the spoofed request")
	}
}
