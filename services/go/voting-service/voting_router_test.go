package main

import (
	"bytes"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"
)

func newTestRouter() http.Handler {
	logger := slog.New(slog.NewTextHandler(io.Discard, nil))
	return newRouter(logger)
}

func doJSON(t *testing.T, h http.Handler, method, path string, body any) *httptest.ResponseRecorder {
	t.Helper()
	var reader *bytes.Reader
	if body != nil {
		b, err := json.Marshal(body)
		if err != nil {
			t.Fatalf("marshal request body: %v", err)
		}
		reader = bytes.NewReader(b)
	} else {
		reader = bytes.NewReader(nil)
	}
	req := httptest.NewRequest(method, path, reader)
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	return rec
}

func decodeBody(t *testing.T, rec *httptest.ResponseRecorder, dst any) {
	t.Helper()
	if err := json.NewDecoder(rec.Body).Decode(dst); err != nil {
		t.Fatalf("decode response body: %v (body=%s)", err, rec.Body.String())
	}
}

func createTestSessionViaHTTP(t *testing.T, h http.Handler, method, thresholdRule string, minParticipation float64, now time.Time) map[string]any {
	t.Helper()
	rec := doJSON(t, h, http.MethodPost, "/voting/sessions", map[string]any{
		"proposal_id":       "prop-1",
		"jurisdiction_id":   "juri-1",
		"method":            method,
		"threshold_rule":    thresholdRule,
		"min_participation": minParticipation,
		"cooling_off_until": now.Add(-time.Hour).Format(time.RFC3339),
		"opens_at":          now.Add(-time.Minute).Format(time.RFC3339),
		"closes_at":         now.Add(-time.Second).Format(time.RFC3339),
	})
	if rec.Code != http.StatusCreated {
		t.Fatalf("create session: status = %d, body = %s", rec.Code, rec.Body.String())
	}
	var session map[string]any
	decodeBody(t, rec, &session)
	return session
}

// TestVotingLifecycleApproval covers the full happy path for method=approval:
// create -> add options -> open (+ token issuance) -> cast ballots -> verify
// inclusion -> close (+ tally + certification).
func TestVotingLifecycleApproval(t *testing.T) {
	h := newTestRouter()
	now := time.Now().UTC()

	session := createTestSessionViaHTTP(t, h, "approval", "simple_majority", 0.5, now)
	sessionID := session["id"].(string)
	if session["status"] != "scheduled" {
		t.Fatalf("status = %v, want scheduled", session["status"])
	}

	optRec := doJSON(t, h, http.MethodPost, "/voting/sessions/"+sessionID+"/options", map[string]any{
		"label": "Option A",
	})
	if optRec.Code != http.StatusCreated {
		t.Fatalf("add option: status = %d, body = %s", optRec.Code, optRec.Body.String())
	}
	var opt map[string]any
	decodeBody(t, optRec, &opt)
	optionID := opt["id"].(string)

	openRec := doJSON(t, h, http.MethodPost, "/voting/sessions/"+sessionID+"/open", map[string]any{
		"eligible_citizen_ids": []string{"citizen-1", "citizen-2"},
	})
	if openRec.Code != http.StatusOK {
		t.Fatalf("open session: status = %d, body = %s", openRec.Code, openRec.Body.String())
	}
	var openResp struct {
		Session      map[string]any `json:"session"`
		IssuedTokens []struct {
			CitizenID   string `json:"citizen_id"`
			TokenSecret string `json:"token_secret"`
		} `json:"issued_tokens"`
	}
	decodeBody(t, openRec, &openResp)
	if openResp.Session["status"] != "open" {
		t.Fatalf("status = %v, want open", openResp.Session["status"])
	}
	if len(openResp.IssuedTokens) != 2 {
		t.Fatalf("issued tokens = %d, want 2", len(openResp.IssuedTokens))
	}

	var verificationCodes []string
	for _, it := range openResp.IssuedTokens {
		castRec := doJSON(t, h, http.MethodPost, "/voting/ballots", map[string]any{
			"session_id":   sessionID,
			"token_secret": it.TokenSecret,
			"choice":       optionID,
		})
		if castRec.Code != http.StatusCreated {
			t.Fatalf("cast ballot: status = %d, body = %s", castRec.Code, castRec.Body.String())
		}
		var ballot map[string]any
		decodeBody(t, castRec, &ballot)
		if _, present := ballot["encrypted_choice"]; present {
			t.Fatal("response must never include encrypted_choice")
		}
		if _, present := ballot["nonce"]; present {
			t.Fatal("response must never include nonce")
		}
		code, _ := ballot["verification_code"].(string)
		if code == "" {
			t.Fatal("expected a non-empty verification_code")
		}
		verificationCodes = append(verificationCodes, code)
	}

	for _, code := range verificationCodes {
		verifyRec := doJSON(t, h, http.MethodGet, "/voting/ballots/verify?session_id="+sessionID+"&code="+code, nil)
		if verifyRec.Code != http.StatusOK {
			t.Fatalf("verify: status = %d", verifyRec.Code)
		}
		var verifyResp map[string]bool
		decodeBody(t, verifyRec, &verifyResp)
		if !verifyResp["found"] {
			t.Fatalf("expected found=true for code %q", code)
		}
	}

	notFoundRec := doJSON(t, h, http.MethodGet, "/voting/ballots/verify?session_id="+sessionID+"&code=deadbeef", nil)
	var notFoundResp map[string]bool
	decodeBody(t, notFoundRec, &notFoundResp)
	if notFoundResp["found"] {
		t.Fatal("expected found=false for a bogus code")
	}

	closeRec := doJSON(t, h, http.MethodPost, "/voting/sessions/"+sessionID+"/close", nil)
	if closeRec.Code != http.StatusOK {
		t.Fatalf("close session: status = %d, body = %s", closeRec.Code, closeRec.Body.String())
	}
	var closeResp struct {
		Session map[string]any `json:"session"`
		Tally   map[string]any `json:"tally"`
	}
	decodeBody(t, closeRec, &closeResp)
	if closeResp.Session["status"] != "certified" {
		t.Fatalf("status = %v, want certified", closeResp.Session["status"])
	}
	if closeResp.Tally["winner_option_id"] != optionID {
		t.Fatalf("winner_option_id = %v, want %v", closeResp.Tally["winner_option_id"], optionID)
	}
	if closeResp.Tally["quorum_met"] != true {
		t.Fatalf("quorum_met = %v, want true", closeResp.Tally["quorum_met"])
	}
}

// TestVotingLifecycleRankedChoice covers the happy path for a second
// method, ranked_choice, including an IRV runoff.
func TestVotingLifecycleRankedChoice(t *testing.T) {
	h := newTestRouter()
	now := time.Now().UTC()

	session := createTestSessionViaHTTP(t, h, "ranked_choice", "simple_majority", 0.5, now)
	sessionID := session["id"].(string)

	var optionIDs []string
	for _, label := range []string{"Alpha", "Beta", "Gamma"} {
		rec := doJSON(t, h, http.MethodPost, "/voting/sessions/"+sessionID+"/options", map[string]any{"label": label})
		if rec.Code != http.StatusCreated {
			t.Fatalf("add option: status = %d", rec.Code)
		}
		var opt map[string]any
		decodeBody(t, rec, &opt)
		optionIDs = append(optionIDs, opt["id"].(string))
	}

	citizenIDs := []string{"c1", "c2", "c3", "c4", "c5"}
	openRec := doJSON(t, h, http.MethodPost, "/voting/sessions/"+sessionID+"/open", map[string]any{
		"eligible_citizen_ids": citizenIDs,
	})
	if openRec.Code != http.StatusOK {
		t.Fatalf("open session: status = %d, body = %s", openRec.Code, openRec.Body.String())
	}
	var openResp struct {
		IssuedTokens []struct {
			CitizenID   string `json:"citizen_id"`
			TokenSecret string `json:"token_secret"`
		} `json:"issued_tokens"`
	}
	decodeBody(t, openRec, &openResp)
	secretFor := map[string]string{}
	for _, it := range openResp.IssuedTokens {
		secretFor[it.CitizenID] = it.TokenSecret
	}

	alpha, beta, gamma := optionIDs[0], optionIDs[1], optionIDs[2]
	// alpha=2 first-choice, beta=1, gamma=2 -> beta eliminated -> its ballot's
	// next choice (alpha) pushes alpha to a majority.
	choices := map[string]string{
		"c1": alpha + "," + gamma,
		"c2": alpha + "," + beta,
		"c3": beta + "," + alpha,
		"c4": gamma + "," + alpha,
		"c5": gamma + "," + beta,
	}
	for citizenID, choice := range choices {
		rec := doJSON(t, h, http.MethodPost, "/voting/ballots", map[string]any{
			"session_id":   sessionID,
			"token_secret": secretFor[citizenID],
			"choice":       choice,
		})
		if rec.Code != http.StatusCreated {
			t.Fatalf("cast ballot for %s: status = %d body=%s", citizenID, rec.Code, rec.Body.String())
		}
	}

	closeRec := doJSON(t, h, http.MethodPost, "/voting/sessions/"+sessionID+"/close", nil)
	if closeRec.Code != http.StatusOK {
		t.Fatalf("close session: status = %d, body = %s", closeRec.Code, closeRec.Body.String())
	}
	var closeResp struct {
		Tally map[string]any `json:"tally"`
	}
	decodeBody(t, closeRec, &closeResp)
	if closeResp.Tally["winner_option_id"] != alpha {
		t.Fatalf("winner_option_id = %v, want %v (alpha)", closeResp.Tally["winner_option_id"], alpha)
	}
}

func TestVotingCastBallotInvalidTokenRejected(t *testing.T) {
	h := newTestRouter()
	now := time.Now().UTC()
	session := createTestSessionViaHTTP(t, h, "approval", "simple_majority", 0.5, now)
	sessionID := session["id"].(string)

	openRec := doJSON(t, h, http.MethodPost, "/voting/sessions/"+sessionID+"/open", map[string]any{
		"eligible_citizen_ids": []string{"citizen-1"},
	})
	if openRec.Code != http.StatusOK {
		t.Fatalf("open session: status = %d", openRec.Code)
	}

	rec := doJSON(t, h, http.MethodPost, "/voting/ballots", map[string]any{
		"session_id":   sessionID,
		"token_secret": "not-a-real-secret",
		"choice":       "optX",
	})
	if rec.Code != http.StatusNotFound {
		t.Fatalf("status = %d, want 404 for unknown token", rec.Code)
	}
}

func TestVotingCastBallotUsedTokenRejected(t *testing.T) {
	h := newTestRouter()
	now := time.Now().UTC()
	session := createTestSessionViaHTTP(t, h, "approval", "simple_majority", 0.5, now)
	sessionID := session["id"].(string)

	openRec := doJSON(t, h, http.MethodPost, "/voting/sessions/"+sessionID+"/open", map[string]any{
		"eligible_citizen_ids": []string{"citizen-1"},
	})
	var openResp struct {
		IssuedTokens []struct {
			TokenSecret string `json:"token_secret"`
		} `json:"issued_tokens"`
	}
	decodeBody(t, openRec, &openResp)
	secret := openResp.IssuedTokens[0].TokenSecret

	first := doJSON(t, h, http.MethodPost, "/voting/ballots", map[string]any{
		"session_id": sessionID, "token_secret": secret, "choice": "optX",
	})
	if first.Code != http.StatusCreated {
		t.Fatalf("first cast: status = %d body=%s", first.Code, first.Body.String())
	}

	second := doJSON(t, h, http.MethodPost, "/voting/ballots", map[string]any{
		"session_id": sessionID, "token_secret": secret, "choice": "optX",
	})
	if second.Code != http.StatusConflict {
		t.Fatalf("status = %d, want 409 for reused token", second.Code)
	}
}

func TestVotingCastBallotIntoNonOpenSessionRejected(t *testing.T) {
	h := newTestRouter()
	now := time.Now().UTC()
	session := createTestSessionViaHTTP(t, h, "approval", "simple_majority", 0.5, now)
	sessionID := session["id"].(string)

	rec := doJSON(t, h, http.MethodPost, "/voting/ballots", map[string]any{
		"session_id": sessionID, "token_secret": "whatever", "choice": "optX",
	})
	if rec.Code != http.StatusConflict {
		t.Fatalf("status = %d, want 409 for casting into a scheduled (non-open) session", rec.Code)
	}
}

func TestVotingQuorumFailurePath(t *testing.T) {
	h := newTestRouter()
	now := time.Now().UTC()
	session := createTestSessionViaHTTP(t, h, "approval", "simple_majority", 0.9, now)
	sessionID := session["id"].(string)

	optRec := doJSON(t, h, http.MethodPost, "/voting/sessions/"+sessionID+"/options", map[string]any{"label": "A"})
	var opt map[string]any
	decodeBody(t, optRec, &opt)
	optionID := opt["id"].(string)

	openRec := doJSON(t, h, http.MethodPost, "/voting/sessions/"+sessionID+"/open", map[string]any{
		"eligible_citizen_ids": []string{"c1", "c2", "c3", "c4"},
	})
	var openResp struct {
		IssuedTokens []struct {
			TokenSecret string `json:"token_secret"`
		} `json:"issued_tokens"`
	}
	decodeBody(t, openRec, &openResp)

	castRec := doJSON(t, h, http.MethodPost, "/voting/ballots", map[string]any{
		"session_id": sessionID, "token_secret": openResp.IssuedTokens[0].TokenSecret, "choice": optionID,
	})
	if castRec.Code != http.StatusCreated {
		t.Fatalf("cast ballot: status = %d", castRec.Code)
	}

	closeRec := doJSON(t, h, http.MethodPost, "/voting/sessions/"+sessionID+"/close", nil)
	if closeRec.Code != http.StatusOK {
		t.Fatalf("close session: status = %d, body=%s", closeRec.Code, closeRec.Body.String())
	}
	var closeResp struct {
		Session map[string]any `json:"session"`
		Tally   map[string]any `json:"tally"`
	}
	decodeBody(t, closeRec, &closeResp)
	if closeResp.Session["status"] != "closed" {
		t.Fatalf("status = %v, want closed (quorum failed, not certified)", closeResp.Session["status"])
	}
	if closeResp.Tally["quorum_met"] != false {
		t.Fatalf("quorum_met = %v, want false", closeResp.Tally["quorum_met"])
	}
}

func TestVotingMalformedJSONRejected(t *testing.T) {
	h := newTestRouter()
	req := httptest.NewRequest(http.MethodPost, "/voting/sessions", bytes.NewReader([]byte("{not-json")))
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400 for malformed JSON", rec.Code)
	}
}

func TestVotingMissingFieldsRejected(t *testing.T) {
	h := newTestRouter()
	rec := doJSON(t, h, http.MethodPost, "/voting/sessions", map[string]any{})
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400 for missing required fields", rec.Code)
	}
}

func TestVotingUnknownSessionReturns404(t *testing.T) {
	h := newTestRouter()
	rec := doJSON(t, h, http.MethodGet, "/voting/sessions/does-not-exist", nil)
	if rec.Code != http.StatusNotFound {
		t.Fatalf("status = %d, want 404", rec.Code)
	}

	rec2 := doJSON(t, h, http.MethodPost, "/voting/sessions/does-not-exist/options", map[string]any{"label": "x"})
	if rec2.Code != http.StatusNotFound {
		t.Fatalf("status = %d, want 404 for AddOption on unknown session", rec2.Code)
	}

	rec3 := doJSON(t, h, http.MethodPost, "/voting/sessions/does-not-exist/open", map[string]any{"eligible_citizen_ids": []string{}})
	if rec3.Code != http.StatusNotFound {
		t.Fatalf("status = %d, want 404 for open on unknown session", rec3.Code)
	}

	rec4 := doJSON(t, h, http.MethodPost, "/voting/sessions/does-not-exist/close", nil)
	if rec4.Code != http.StatusNotFound {
		t.Fatalf("status = %d, want 404 for close on unknown session", rec4.Code)
	}
}

func TestVotingHealthzStillWorks(t *testing.T) {
	h := newTestRouter()
	rec := doJSON(t, h, http.MethodGet, "/healthz", nil)
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200", rec.Code)
	}
}
