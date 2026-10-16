package auth

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"strings"
	"testing"
	"time"
)

// No browser dependency or fake identity checker is linked into the app.
// The opt-in test uses the real handlers and a test-only same-origin gateway.
func TestBrowserPasskeyMemory(t *testing.T) {
	if os.Getenv("REQUIRE_BROWSER_TESTS") != "1" {
		t.Skip("set REQUIRE_BROWSER_TESTS=1 to run Chromium WebAuthn validation")
	}
	testBrowserPasskey(t, testService())
}

func TestBrowserPasskeyPostgres(t *testing.T) {
	if os.Getenv("REQUIRE_BROWSER_TESTS") != "1" {
		t.Skip("set REQUIRE_BROWSER_TESTS=1 to run Chromium WebAuthn validation")
	}
	testBrowserPasskey(t, NewService(pgTestStore(t), activeIdentityChecker{}, nil, nil))
}

func testBrowserPasskey(t *testing.T, svc *Service) {
	t.Helper()
	mux := http.NewServeMux()
	mux.HandleFunc("GET /{$}", func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "text/html")
		_, _ = w.Write([]byte("<!doctype html><title>Passkey test harness</title>"))
	})
	server := httptest.NewServer(mux)
	defer server.Close()
	origin := strings.Replace(server.URL, "127.0.0.1", "localhost", 1)
	t.Setenv("WEBAUTHN_RP_ID", "localhost")
	t.Setenv("WEBAUTHN_RP_ORIGIN", origin)
	router := NewRouter(svc, nil, "browser-test-secret")
	mux.Handle("/auth/", router)

	citizen := newID()
	body, _ := json.Marshal(map[string]string{"citizen_id": citizen})
	issued := httptest.NewRecorder()
	router.ServeHTTP(issued, signedInternalRequest(t, http.MethodPost, "/auth/identities/provision", body, "api-ts", "browser-test-secret", time.Now().UTC()))
	if issued.Code != http.StatusCreated {
		t.Fatalf("provision failed with status %d", issued.Code)
	}
	var grant struct {
		Token string `json:"enrollment_grant"`
	}
	if err := json.Unmarshal(issued.Body.Bytes(), &grant); err != nil {
		t.Fatal(err)
	}
	config, err := json.Marshal(map[string]string{"origin": origin, "citizenId": citizen, "grant": grant.Token})
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 45*time.Second)
	defer cancel()
	// The grant goes through stdin, never a command-line argument or test log.
	cmd := exec.CommandContext(ctx, "node", "../../../../testing/browser/passkey.mjs")
	cmd.Stdin = bytes.NewReader(config)
	if output, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("browser check failed: %v\n%s", err, output)
	}
}
