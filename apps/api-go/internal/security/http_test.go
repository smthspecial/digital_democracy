package security

import (
	"bytes"
	"errors"
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestSignedBoundaryRejectsReplayAndTampering(t *testing.T) {
	a := &Access{Secret: "test-key", Replays: &ReplayStore{}}
	h := a.Internal("api-ts", http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { w.WriteHeader(204) }))
	body := []byte(`{"value":1}`)
	request := httptest.NewRequest("POST", "/worker?cursor=one", bytes.NewReader(body))
	Sign(request, "api-ts", "test-key", body)
	run := func(req *http.Request) int { w := httptest.NewRecorder(); h.ServeHTTP(w, req); return w.Code }
	if got := run(request.Clone(request.Context())); got != 204 {
		t.Fatalf("signed call: %d", got)
	}
	replay := request.Clone(request.Context())
	replay.Body = http.NoBody
	// Preserve body for the exact replay.
	replay.Body = httptest.NewRequest("POST", "/", bytes.NewReader(body)).Body
	if got := run(replay); got != 401 {
		t.Fatalf("replay: %d", got)
	}
	tampered := httptest.NewRequest("POST", "/worker?cursor=two", bytes.NewReader(body))
	tampered.Header = request.Header.Clone()
	if got := run(tampered); got != 401 {
		t.Fatalf("unsigned query modification: %d", got)
	}
	unknown := httptest.NewRequest("POST", "/worker", bytes.NewReader(body))
	Sign(unknown, "attacker", "test-key", body)
	if got := run(unknown); got != 401 {
		t.Fatalf("unknown producer: %d", got)
	}
	big := bytes.Repeat([]byte("x"), MaxBody+1)
	oversize := httptest.NewRequest("POST", "/worker", bytes.NewReader(big))
	Sign(oversize, "api-ts", "test-key", big)
	if got := run(oversize); got != 413 {
		t.Fatalf("body bound: %d", got)
	}
}

func TestCitizenAssuranceAndSpoofedHeaders(t *testing.T) {
	a := &Access{Validate: func(token string) (string, string, error) {
		if token == "bad" {
			return "", "", errors.New("invalid")
		}
		return "owner", token, nil
	}}
	h := a.Citizen("T3", http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if CitizenID(r) != "owner" {
			t.Fatal("spoofed citizen used")
		}
		w.WriteHeader(204)
	}))
	for token, want := range map[string]int{"bad": 401, "T1": 403, "T2": 403, "unknown": 403, "T3": 204} {
		req := httptest.NewRequest("POST", "/ballot", nil)
		req.Header.Set("Authorization", "Bearer "+token)
		req.Header.Set("X-Citizen-ID", "attacker")
		w := httptest.NewRecorder()
		h.ServeHTTP(w, req)
		if w.Code != want {
			t.Fatalf("%s: %d", token, w.Code)
		}
	}
}

func TestRateLimitIgnoresForwardedAddresses(t *testing.T) {
	h := Limit(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { w.WriteHeader(204) }))
	for i := 0; i < 121; i++ {
		req := httptest.NewRequest("GET", "/", nil)
		req.RemoteAddr = "127.0.0.1:1234"
		req.Header.Set("X-Forwarded-For", string(rune(i+1)))
		w := httptest.NewRecorder()
		h.ServeHTTP(w, req)
		want := 204
		if i == 120 {
			want = 429
		}
		if w.Code != want {
			t.Fatalf("request %d: %d", i, w.Code)
		}
	}
}
