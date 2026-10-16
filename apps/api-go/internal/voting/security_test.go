package voting

import (
	"bytes"
	"encoding/json"
	"errors"
	"github.com/digital-democracy/api-go/internal/security"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"
)

func TestBallotHTTPBoundary(t *testing.T) {
	svc := NewService(nil, nil, nil)
	session := testSession(t, svc)
	option, err := svc.store.AddOption(&VoteOption{SessionID: session.ID, ProposalID: "p", Label: "A"})
	if err != nil {
		t.Fatal(err)
	}
	openTestSession(t, svc, session)
	tokens, _ := svc.IssueTokens(session.ID, []string{"owner"})
	token := tokens[0]
	verifier := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !security.Verify(w, r, "api-go", "proof-test-key", &security.ReplayStore{}) {
			return
		}
		var in map[string]string
		json.NewDecoder(r.Body).Decode(&in)
		if in["citizen_id"] != "" || in["token_blind"] != "" {
			t.Error("ballot proof verifier received identity")
		}
		json.NewEncoder(w).Encode(map[string]bool{"valid": in["encrypted_choice"] == option.ID && in["proof"] == "valid-test-proof"})
	}))
	defer verifier.Close()
	t.Setenv("BALLOT_VERIFIER_URL", verifier.URL)
	t.Setenv("INTERNAL_SERVICE_SHARED_SECRET", "proof-test-key")
	access := &security.Access{Validate: func(token string) (string, string, error) {
		switch token {
		case "owner":
			return "owner", "T3", nil
		case "other":
			return "other", "T3", nil
		case "low":
			return "owner", "T1", nil
		}
		return "", "", errors.New("invalid")
	}}
	router := security.Limit(NewRouter(svc, nil, access))
	run := func(bearer, choice, proof string) int {
		body, _ := json.Marshal(map[string]string{"vote_session_id": session.ID, "token_id": token.ID, "token_blind": token.TokenBlind, "encrypted_choice": choice, "proof": proof})
		req := httptest.NewRequest("POST", "/voting/ballots", bytes.NewReader(body))
		req.Header.Set("Authorization", "Bearer "+bearer)
		w := httptest.NewRecorder()
		router.ServeHTTP(w, req)
		return w.Code
	}
	for _, tc := range []struct {
		bearer, choice, proof string
		want                  int
	}{{"invalid", option.ID, "valid-test-proof", 401}, {"low", option.ID, "valid-test-proof", 403}, {"other", option.ID, "valid-test-proof", 400}, {"owner", "unregistered-choice", "valid-test-proof", 400}, {"owner", option.ID, "", 400}, {"owner", option.ID, "valid-test-proof", 201}, {"owner", option.ID, "valid-test-proof", 409}} {
		if got := run(tc.bearer, tc.choice, tc.proof); got != tc.want {
			t.Fatalf("%+v got %d", tc, got)
		}
	}
	ballots, _ := svc.store.BallotsForSession(session.ID)
	if len(ballots) != 1 || ballots[0].TokenBlind == token.TokenBlind {
		t.Fatal("ballot retains eligibility token")
	}
}

func TestDeadlineAndFrozenOptions(t *testing.T) {
	svc := NewService(nil, nil, nil)
	session := testSession(t, svc)
	openTestSession(t, svc, session)
	if _, err := svc.store.AddOption(&VoteOption{SessionID: session.ID, Label: "late"}); err != ErrInvalidState {
		t.Fatalf("late option: %v", err)
	}
	tokens, _ := svc.IssueTokens(session.ID, []string{"owner"})
	st := svc.store.(*MemoryStore)
	st.mu.Lock()
	st.sessions[session.ID].ClosesAt = time.Now().Add(-time.Second)
	st.mu.Unlock()
	if _, err := svc.CastBallot(session.ID, tokens[0].ID, tokens[0].TokenBlind, "A", "owner"); err != ErrInvalidState {
		t.Fatalf("expired ballot: %v", err)
	}
	another := testSession(t, svc)
	st.mu.Lock()
	st.sessions[another.ID].ClosesAt = time.Now().Add(-time.Second)
	st.mu.Unlock()
	if _, err := svc.TryOpen(another.ID, time.Now()); err != ErrInvalidState {
		t.Fatalf("expired open: %v", err)
	}
}

func TestPGDeadlineOptionsAndAnonymousStorage(t *testing.T) {
	store := pgTestStore(t)
	svc := NewService(store, nil, nil)
	session := pgTestSession(t, svc)
	owner := newID()
	tokens, _ := svc.IssueTokens(session.ID, []string{owner})
	if _, err := store.AddOption(&VoteOption{SessionID: session.ID, ProposalID: newID(), Label: "late"}); err != ErrInvalidState {
		t.Fatalf("late PG option: %v", err)
	}
	ballot, err := svc.CastBallot(session.ID, tokens[0].ID, tokens[0].TokenBlind, "A", owner)
	if err != nil {
		t.Fatal(err)
	}
	if ballot.TokenBlind == tokens[0].TokenBlind {
		t.Fatal("PG ballot retains eligibility token")
	}
	other := newID()
	next, _ := svc.IssueTokens(session.ID, []string{other})
	ctx, cancel := opCtx()
	defer cancel()
	if _, err = store.pool.Exec(ctx, "UPDATE vote_session SET closes_at=now()-interval '1 second' WHERE id=$1", session.ID); err != nil {
		t.Fatal(err)
	}
	if _, err = svc.CastBallot(session.ID, next[0].ID, next[0].TokenBlind, "A", other); err != ErrInvalidState {
		t.Fatalf("late PG ballot: %v", err)
	}
}
