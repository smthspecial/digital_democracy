package audit

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"sync"
	"testing"
	"time"
)

func newTestServer(t *testing.T) (*httptest.Server, *Service) {
	t.Helper()
	svc := NewService(nil, nil)
	srv := httptest.NewServer(NewRouter(svc, testLogger()))
	t.Cleanup(srv.Close)
	return srv, svc
}

func postJSON(t *testing.T, url string, body any) *http.Response {
	t.Helper()
	b, err := json.Marshal(body)
	if err != nil {
		t.Fatal(err)
	}
	resp, err := http.Post(url, "application/json", bytes.NewReader(b))
	if err != nil {
		t.Fatal(err)
	}
	return resp
}

func decodeBody(t *testing.T, resp *http.Response, v any) {
	t.Helper()
	defer resp.Body.Close()
	if err := json.NewDecoder(resp.Body).Decode(v); err != nil {
		t.Fatal(err)
	}
}

// TP-013 HP-1: five appends chain sequentially and verify.
func TestHTTPAppendFiveEntriesChainAndVerify(t *testing.T) {
	srv, _ := newTestServer(t)
	var entries []AuditEntry
	for i := 0; i < 5; i++ {
		resp := postJSON(t, srv.URL+"/audit/log", map[string]string{
			"action_type": ActionSystemUpdate, "actor_ref": "test", "payload": fmt.Sprintf("p-%d", i),
		})
		if resp.StatusCode != http.StatusCreated {
			t.Fatalf("append %d status = %d", i, resp.StatusCode)
		}
		var e AuditEntry
		decodeBody(t, resp, &e)
		entries = append(entries, e)
	}

	resp, err := http.Get(srv.URL + "/audit/log")
	if err != nil {
		t.Fatal(err)
	}
	var listOut struct {
		Entries []AuditEntry `json:"entries"`
	}
	decodeBody(t, resp, &listOut)
	if len(listOut.Entries) != 5 {
		t.Fatalf("listed %d entries, want 5", len(listOut.Entries))
	}
	if listOut.Entries[0].PrevHash != GenesisPrevHash {
		t.Fatalf("first entry prev_hash = %q, want genesis", listOut.Entries[0].PrevHash)
	}
	for i := 1; i < len(listOut.Entries); i++ {
		if listOut.Entries[i].PrevHash != listOut.Entries[i-1].PayloadHash {
			t.Fatalf("entry %d prev_hash does not chain to entry %d's payload_hash", i, i-1)
		}
	}

	verifyResp, err := http.Get(srv.URL + "/audit/verify")
	if err != nil {
		t.Fatal(err)
	}
	var v struct {
		Valid bool `json:"valid"`
	}
	decodeBody(t, verifyResp, &v)
	if !v.Valid {
		t.Fatal("chain not valid after 5 real appends")
	}
}

// TP-013 EC-1..EC-3: input validation on POST /audit/log.
func TestHTTPAppendRejectsInvalidActionType(t *testing.T) {
	srv, _ := newTestServer(t)
	resp := postJSON(t, srv.URL+"/audit/log", map[string]string{"action_type": "bogus", "actor_ref": "x", "payload": "p"})
	if resp.StatusCode != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400", resp.StatusCode)
	}
}

func TestHTTPAppendRejectsEmptyActorRef(t *testing.T) {
	srv, _ := newTestServer(t)
	resp := postJSON(t, srv.URL+"/audit/log", map[string]string{"action_type": ActionSystemUpdate, "actor_ref": "", "payload": "p"})
	if resp.StatusCode != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400", resp.StatusCode)
	}
}

func TestHTTPAppendRejectsMalformedJSON(t *testing.T) {
	srv, _ := newTestServer(t)
	resp, err := http.Post(srv.URL+"/audit/log", "application/json", bytes.NewReader([]byte("{not json")))
	if err != nil {
		t.Fatal(err)
	}
	if resp.StatusCode != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400", resp.StatusCode)
	}
}

// TP-013 EC-4: GET /audit/log?action_type=bogus rejects, and a valid filter
// actually filters (fixed -- previously the query param was silently
// ignored entirely).
func TestHTTPListRejectsInvalidActionTypeFilter(t *testing.T) {
	srv, _ := newTestServer(t)
	resp, err := http.Get(srv.URL + "/audit/log?action_type=bogus")
	if err != nil {
		t.Fatal(err)
	}
	if resp.StatusCode != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400", resp.StatusCode)
	}
}

func TestHTTPListFiltersByActionType(t *testing.T) {
	srv, _ := newTestServer(t)
	postJSON(t, srv.URL+"/audit/log", map[string]string{"action_type": ActionSystemUpdate, "actor_ref": "x", "payload": "a"})
	postJSON(t, srv.URL+"/audit/log", map[string]string{"action_type": ActionVoteCertified, "actor_ref": "x", "payload": "b"})
	postJSON(t, srv.URL+"/audit/log", map[string]string{"action_type": ActionSystemUpdate, "actor_ref": "x", "payload": "c"})

	resp, err := http.Get(srv.URL + "/audit/log?action_type=" + ActionVoteCertified)
	if err != nil {
		t.Fatal(err)
	}
	var out struct {
		Entries []AuditEntry `json:"entries"`
	}
	decodeBody(t, resp, &out)
	if len(out.Entries) != 1 || out.Entries[0].ActionType != ActionVoteCertified {
		t.Fatalf("filtered entries = %+v, want exactly one vote_certified entry", out.Entries)
	}
}

// TP-013 EC-5: POST /audit/rights rejects an empty name.
func TestHTTPCreateRightRejectsEmptyName(t *testing.T) {
	srv, _ := newTestServer(t)
	resp := postJSON(t, srv.URL+"/audit/rights", map[string]any{"name": "", "description": "d", "protected": true})
	if resp.StatusCode != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400", resp.StatusCode)
	}
}

// TP-013 EC-34: first entry's prev_hash is the genesis constant.
func TestHTTPFirstEntryHasGenesisPrevHash(t *testing.T) {
	srv, _ := newTestServer(t)
	resp := postJSON(t, srv.URL+"/audit/log", map[string]string{"action_type": ActionSystemUpdate, "actor_ref": "x", "payload": "p"})
	var e AuditEntry
	decodeBody(t, resp, &e)
	if e.PrevHash != GenesisPrevHash {
		t.Fatalf("prev_hash = %q, want genesis", e.PrevHash)
	}
}

// TP-013 EC-35: idempotency dedupe -- the first payload wins, even when a
// redelivery carries a different payload.
func TestHTTPIdempotencyFirstPayloadWins(t *testing.T) {
	srv, _ := newTestServer(t)
	first := postJSON(t, srv.URL+"/audit/log", map[string]string{
		"action_type": ActionSystemUpdate, "actor_ref": "x", "payload": "original", "idempotency_key": "k1",
	})
	var e1 AuditEntry
	decodeBody(t, first, &e1)

	second := postJSON(t, srv.URL+"/audit/log", map[string]string{
		"action_type": ActionSystemUpdate, "actor_ref": "x", "payload": "different", "idempotency_key": "k1",
	})
	var e2 AuditEntry
	decodeBody(t, second, &e2)

	if e1.ID != e2.ID || e1.PayloadHash != e2.PayloadHash {
		t.Fatalf("redelivery returned a different entry: first=%+v second=%+v", e1, e2)
	}

	verifyResp, err := http.Get(srv.URL + "/audit/verify")
	if err != nil {
		t.Fatal(err)
	}
	var v struct {
		Entries int `json:"entries"`
	}
	decodeBody(t, verifyResp, &v)
	if v.Entries != 1 {
		t.Fatalf("entries = %d, want exactly 1", v.Entries)
	}
}

// TP-013 EC-36/HP-7: concurrent appends and reads against the live HTTP
// server produce no lost/duplicated entries and a chain that still verifies.
func TestHTTPConcurrentAppendsAndReadsStayConsistent(t *testing.T) {
	srv, _ := newTestServer(t)
	for i := 0; i < 10; i++ {
		postJSON(t, srv.URL+"/audit/log", map[string]string{"action_type": ActionSystemUpdate, "actor_ref": "seed", "payload": fmt.Sprint(i)})
	}

	var wg sync.WaitGroup
	for i := 0; i < 20; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			postJSON(t, srv.URL+"/audit/log", map[string]string{
				"action_type": ActionSystemUpdate, "actor_ref": "concurrent", "payload": fmt.Sprintf("c-%d", i),
			})
		}(i)
	}
	for i := 0; i < 2; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			resp, err := http.Get(srv.URL + "/audit/log")
			if err != nil {
				t.Error(err)
				return
			}
			resp.Body.Close()
		}()
	}
	wg.Wait()

	resp, err := http.Get(srv.URL + "/audit/verify")
	if err != nil {
		t.Fatal(err)
	}
	var v struct {
		Valid   bool `json:"valid"`
		Entries int  `json:"entries"`
	}
	decodeBody(t, resp, &v)
	if !v.Valid {
		t.Fatal("chain invalid after concurrent appends")
	}
	if v.Entries != 30 {
		t.Fatalf("entries = %d, want 30 (10 seed + 20 concurrent, no lost/duplicated)", v.Entries)
	}
}

// TP-013 EC-46: a protocol-change release that does not (yet) satisfy the
// gate writes no audit-log entry -- proven here at the HTTP surface, not
// just via direct Service calls.
func TestHTTPFailedProtocolGateReleaseWritesNoAuditEntry(t *testing.T) {
	srv, _ := newTestServer(t)
	resp := postJSON(t, srv.URL+"/audit/protocol-changes", map[string]any{
		"change_ref": "change-1", "required_approval_refs": []string{"approval-1"},
		"delay_until": time.Now().Add(24 * time.Hour), "visible_since": time.Now().Add(-time.Hour),
	})
	var change struct {
		ID string `json:"id"`
	}
	decodeBody(t, resp, &change)

	before, err := http.Get(srv.URL + "/audit/verify")
	if err != nil {
		t.Fatal(err)
	}
	var beforeCount struct {
		Entries int `json:"entries"`
	}
	decodeBody(t, before, &beforeCount)

	releaseResp, err := http.Post(srv.URL+"/audit/protocol-changes/"+change.ID+"/release", "application/json", nil)
	if err != nil {
		t.Fatal(err)
	}
	if releaseResp.StatusCode != http.StatusUnprocessableEntity {
		t.Fatalf("release status = %d, want 422 (approvals incomplete)", releaseResp.StatusCode)
	}

	after, err := http.Get(srv.URL + "/audit/verify")
	if err != nil {
		t.Fatal(err)
	}
	var afterCount struct {
		Entries int `json:"entries"`
	}
	decodeBody(t, after, &afterCount)
	if afterCount.Entries != beforeCount.Entries {
		t.Fatalf("entries went from %d to %d across a failed release", beforeCount.Entries, afterCount.Entries)
	}
}

// TP-013 EC-52 (ABUSE-AUDIT-1): actor_ref is a self-declared, unauthenticated
// string. A forged entry claiming a service that never sent it still lands
// and the chain still verifies.
func TestHTTPForgedActorRefPassesChainVerification(t *testing.T) {
	srv, _ := newTestServer(t)
	resp := postJSON(t, srv.URL+"/audit/log", map[string]string{
		"action_type": ActionVoteCertified, "actor_ref": "voting-service", "payload": "session-that-was-never-certified",
	})
	if resp.StatusCode != http.StatusCreated {
		t.Fatalf("forged-actor append status = %d, want 201", resp.StatusCode)
	}

	verifyResp, err := http.Get(srv.URL + "/audit/verify")
	if err != nil {
		t.Fatal(err)
	}
	var v struct {
		Valid bool `json:"valid"`
	}
	decodeBody(t, verifyResp, &v)
	if !v.Valid {
		t.Fatal("chain reported invalid for a forged-but-well-formed entry -- it should still be valid: the chain proves sequence, not authorship")
	}
}

// TP-013 EC-51: nothing inside audit-service inspects payload content --
// NFR-001 ("ballot content is never logged") is caller-discipline only.
func TestHTTPPayloadContentIsNeverValidated(t *testing.T) {
	srv, _ := newTestServer(t)
	resp := postJSON(t, srv.URL+"/audit/log", map[string]string{
		"action_type": ActionSystemUpdate, "actor_ref": "x", "payload": "ballot_selection:candidate-42",
	})
	if resp.StatusCode != http.StatusCreated {
		t.Fatalf("status = %d, want 201 -- audit-service accepts any payload content, including ballot-shaped strings", resp.StatusCode)
	}
}

// TP-013 EC-50: Signature is a deterministic hash of public fields, not a
// keyed HMAC -- anyone who can compute an entry's Hash can compute a
// passing Signature with no secret.
func TestHTTPSignatureIsPubliclyComputableNotHMAC(t *testing.T) {
	srv, _ := newTestServer(t)
	resp := postJSON(t, srv.URL+"/audit/log", map[string]string{"action_type": ActionSystemUpdate, "actor_ref": "x", "payload": "p"})
	var e AuditEntry
	decodeBody(t, resp, &e)

	sum := sha256.Sum256([]byte(e.Hash + ".audit-service"))
	want := "sig:" + hex.EncodeToString(sum[:])
	if e.Signature != want {
		t.Fatalf("signature = %q, want %q (a real HMAC would need a secret key this formula never uses)", e.Signature, want)
	}
}

// TP-013 EC-28 (audit-service side): neither the constitutional-review nor
// the protocol-change-release endpoint checks caller identity at all.
func TestHTTPTriggerReviewAndReleaseChangeHaveNoAuthCheck(t *testing.T) {
	srv, _ := newTestServer(t)
	resp := postJSON(t, srv.URL+"/audit/reviews", map[string]any{
		"proposal_id": "p1", "affected_right_ids": []string{}, "reviewer_ref": "anyone",
	})
	if resp.StatusCode != http.StatusCreated {
		t.Fatalf("triggerReview with no auth header status = %d, want 201 -- no caller-identity check exists", resp.StatusCode)
	}
}

// TP-013 EC-47 (adapted): TriggerReview no longer runs any content-based
// keyword match (that mechanism does not exist in the current codebase) --
// it trusts the caller's AffectedRightIDs outright. A rights-violating
// change that the caller simply does not declare as affected clears with
// zero independent verification, which is a strictly easier bypass than the
// old keyword-rephrasing evasion this scenario originally documented.
func TestHTTPTriggerReviewTrustsCallerDeclaredAffectedRightsWithNoContentCheck(t *testing.T) {
	srv, _ := newTestServer(t)
	rightResp := postJSON(t, srv.URL+"/audit/rights", map[string]any{
		"name": "freedom of speech", "description": "d", "protected": true,
	})
	var right struct {
		ID string `json:"id"`
	}
	decodeBody(t, rightResp, &right)

	reviewResp := postJSON(t, srv.URL+"/audit/reviews", map[string]any{
		"proposal_id": "ban-public-criticism-of-officials", "affected_right_ids": []string{}, "reviewer_ref": "anyone",
	})
	var out struct {
		Blocked bool `json:"blocked"`
	}
	decodeBody(t, reviewResp, &out)
	if out.Blocked {
		t.Fatal("review was blocked despite the caller declaring zero affected rights -- test assumption invalid, re-check TriggerReview")
	}
}
