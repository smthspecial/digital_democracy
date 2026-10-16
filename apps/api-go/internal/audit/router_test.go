package audit

import (
	"bytes"
	"crypto/ed25519"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"github.com/digital-democracy/api-go/internal/security"
	"net/http"
	"net/http/httptest"
	"sync"
	"testing"
)

func newTestServer(t *testing.T) (*httptest.Server, *Service) {
	t.Helper()
	svc := NewService(nil, nil)
	srv := httptest.NewServer(NewRouter(svc, testLogger(), &security.Access{Secret: "audit-http-test-secret", Replays: &security.ReplayStore{}}))
	t.Cleanup(srv.Close)
	return srv, svc
}

func postJSON(t *testing.T, url string, body any) *http.Response {
	t.Helper()
	b, err := json.Marshal(body)
	if err != nil {
		t.Fatal(err)
	}
	req, _ := http.NewRequest("POST", url, bytes.NewReader(b))
	req.Header.Set("Content-Type", "application/json")
	security.Sign(req, "api-ts", "audit-http-test-secret", b)
	resp, err := http.DefaultClient.Do(req)
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
	req, _ := http.NewRequest("POST", srv.URL+"/audit/log", bytes.NewReader([]byte("{not json")))
	security.Sign(req, "api-ts", "audit-http-test-secret", []byte("{not json"))
	resp, err := http.DefaultClient.Do(req)
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
	srv, svc := newTestServer(t)
	postJSON(t, srv.URL+"/audit/log", map[string]string{"action_type": ActionSystemUpdate, "actor_ref": "x", "payload": "a"})
	svc.Append(ActionVoteCertified, "voting-service", "b", "")
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
		"change_ref": "change-1",
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

	releaseResp := postJSON(t, srv.URL+"/audit/protocol-changes/"+change.ID+"/release", map[string]any{})
	if releaseResp.StatusCode != http.StatusServiceUnavailable {
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

// Security regressions: provenance, ballot privacy and real signatures.
func TestHTTPForgedActorRejected(t *testing.T) {
	srv, _ := newTestServer(t)
	resp := postJSON(t, srv.URL+"/audit/log", map[string]string{"action_type": ActionVoteCertified, "actor_ref": "voting-service", "payload": "forged"})
	defer resp.Body.Close()
	if resp.StatusCode != 403 {
		t.Fatalf("forged actor accepted: %d", resp.StatusCode)
	}
}
func TestHTTPBallotPayloadRejected(t *testing.T) {
	srv, _ := newTestServer(t)
	resp := postJSON(t, srv.URL+"/audit/log", map[string]string{"action_type": ActionSystemUpdate, "actor_ref": "x", "payload": "ballot_selection:candidate-42"})
	defer resp.Body.Close()
	if resp.StatusCode != 400 {
		t.Fatalf("ballot leaked: %d", resp.StatusCode)
	}
}
func TestHTTPSignatureVerifiesWithPublicKey(t *testing.T) {
	srv, svc := newTestServer(t)
	resp := postJSON(t, srv.URL+"/audit/log", map[string]string{"action_type": ActionSystemUpdate, "actor_ref": "x", "payload": "p"})
	var e AuditEntry
	decodeBody(t, resp, &e)
	key, _ := base64.RawURLEncoding.DecodeString(svc.store.PublicKey())
	if len(e.Signature) <= 8 {
		t.Fatal("signature missing")
	}
	sig, _ := base64.RawURLEncoding.DecodeString(e.Signature[8:])
	if !ed25519.Verify(key, []byte(e.ID+"\n"+e.Hash), sig) {
		t.Fatal("invalid Ed25519 signature")
	}
	if ed25519.Verify(key, []byte(e.ID+"\nforged"), sig) {
		t.Fatal("tamper accepted")
	}
}
func TestHTTPReviewRequiresAuthentication(t *testing.T) {
	srv, _ := newTestServer(t)
	resp, err := http.Post(srv.URL+"/audit/reviews", "application/json", bytes.NewBufferString(`{"proposal_id":"p","reviewer_ref":"forged","affected_right_ids":[]}`))
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != 401 {
		t.Fatalf("anonymous review: %d", resp.StatusCode)
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
