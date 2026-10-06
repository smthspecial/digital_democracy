package auth

import (
	"bytes"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/binary"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/fxamacker/cbor/v2"
)

func b64(data []byte) string { return base64.RawURLEncoding.EncodeToString(data) }

func perform(t *testing.T, router http.Handler, path, token string, body any) *httptest.ResponseRecorder {
	t.Helper()
	data, err := json.Marshal(body)
	if err != nil {
		t.Fatal(err)
	}
	req := httptest.NewRequest(http.MethodPost, path, bytes.NewReader(data))
	if token != "" {
		req.Header.Set("Authorization", "Bearer "+token)
	}
	result := httptest.NewRecorder()
	router.ServeHTTP(result, req)
	return result
}

func ceremonyOptions(t *testing.T, r *httptest.ResponseRecorder) (string, string) {
	t.Helper()
	if r.Code != http.StatusOK {
		t.Fatalf("begin failed: %d %s", r.Code, r.Body.String())
	}
	var result struct {
		Token   string `json:"ceremony_token"`
		Options struct {
			PublicKey struct {
				Challenge string `json:"challenge"`
			} `json:"publicKey"`
		} `json:"options"`
	}
	if err := json.Unmarshal(r.Body.Bytes(), &result); err != nil {
		t.Fatal(err)
	}
	return result.Token, result.Options.PublicKey.Challenge
}

func testRegistration(t *testing.T, challenge, origin string, key *ecdsa.PrivateKey, id []byte) map[string]any {
	t.Helper()
	client, _ := json.Marshal(map[string]any{"type": "webauthn.create", "challenge": challenge, "origin": origin, "crossOrigin": false})
	rp := sha256.Sum256([]byte("localhost"))
	authData := append(rp[:], byte(0x45)) // UP, UV, attested credential present.
	authData = append(authData, 0, 0, 0, 0)
	authData = append(authData, make([]byte, 16)...)
	authData = binary.BigEndian.AppendUint16(authData, uint16(len(id)))
	authData = append(authData, id...)
	publicKey, err := cbor.Marshal(map[int]any{1: 2, 3: -7, -1: 1, -2: key.X.FillBytes(make([]byte, 32)), -3: key.Y.FillBytes(make([]byte, 32))})
	if err != nil {
		t.Fatal(err)
	}
	authData = append(authData, publicKey...)
	attestation, err := cbor.Marshal(map[string]any{"fmt": "none", "authData": authData, "attStmt": map[string]any{}})
	if err != nil {
		t.Fatal(err)
	}
	return map[string]any{"id": b64(id), "rawId": b64(id), "type": "public-key", "response": map[string]any{"clientDataJSON": b64(client), "attestationObject": b64(attestation)}}
}

func testAssertion(t *testing.T, challenge, origin, citizen string, key *ecdsa.PrivateKey, id []byte) map[string]any {
	t.Helper()
	client, _ := json.Marshal(map[string]any{"type": "webauthn.get", "challenge": challenge, "origin": origin, "crossOrigin": false})
	rp := sha256.Sum256([]byte("localhost"))
	authData := append(rp[:], byte(0x05))
	authData = binary.BigEndian.AppendUint32(authData, 1)
	clientHash := sha256.Sum256(client)
	digest := sha256.Sum256(append(authData, clientHash[:]...))
	signature, err := ecdsa.SignASN1(rand.Reader, key, digest[:])
	if err != nil {
		t.Fatal(err)
	}
	return map[string]any{"id": b64(id), "rawId": b64(id), "type": "public-key", "response": map[string]any{"clientDataJSON": b64(client), "authenticatorData": b64(authData), "signature": b64(signature), "userHandle": b64(passkeyUser{id: citizen}.WebAuthnID())}}
}

func TestPasskeyProvisionRegisterAndLogin(t *testing.T) {
	testPasskeyFlow(t, testService())
}

func TestPGPasskeyProvisionRegisterAndLogin(t *testing.T) {
	testPasskeyFlow(t, NewService(pgTestStore(t), activeIdentityChecker{}, nil, nil))
}

func testPasskeyFlow(t *testing.T, svc *Service) {
	t.Helper()
	t.Setenv("WEBAUTHN_RP_ID", "localhost")
	t.Setenv("WEBAUTHN_RP_ORIGIN", "http://localhost:3000")
	router := NewRouter(svc, nil, "service-secret")
	citizen := newID()
	body, _ := json.Marshal(map[string]string{"citizen_id": citizen})
	req := signedInternalRequest(t, http.MethodPost, "/auth/identities/provision", body, "api-ts", "service-secret", time.Now().UTC())
	issued := httptest.NewRecorder()
	router.ServeHTTP(issued, req)
	if issued.Code != http.StatusCreated {
		t.Fatalf("provision: %d %s", issued.Code, issued.Body.String())
	}
	var grant struct {
		Token string `json:"enrollment_grant"`
	}
	_ = json.Unmarshal(issued.Body.Bytes(), &grant)
	// Enrollment grants never authenticate a normal citizen API request.
	if _, err := svc.Validate(grant.Token, time.Now().UTC()); err != ErrUnauthorized {
		t.Fatalf("grant validated as access token: %v", err)
	}
	token, challenge := ceremonyOptions(t, perform(t, router, "/auth/passkeys/registration/begin", grant.Token, map[string]any{}))
	if replay := perform(t, router, "/auth/passkeys/registration/begin", grant.Token, map[string]any{}); replay.Code != 401 {
		t.Fatalf("grant replay: %d", replay.Code)
	}
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	id := []byte("test-passkey")
	finish := perform(t, router, "/auth/passkeys/registration/finish", token, testRegistration(t, challenge, "http://localhost:3000", key, id))
	if finish.Code != 201 {
		t.Fatalf("registration: %d %s", finish.Code, finish.Body.String())
	}
	token, challenge = ceremonyOptions(t, perform(t, router, "/auth/passkeys/login/begin", "", map[string]string{"citizen_id": citizen, "device_fingerprint": "fp", "ip_subnet": "sub"}))
	assertion := testAssertion(t, challenge, "http://localhost:3000", citizen, key, id)
	logged := perform(t, router, "/auth/passkeys/login/finish", token, assertion)
	if logged.Code != 201 {
		t.Fatalf("login: %d %s", logged.Code, logged.Body.String())
	}
	var session struct {
		AccessToken string `json:"access_token"`
	}
	_ = json.Unmarshal(logged.Body.Bytes(), &session)
	validated, err := svc.Validate(session.AccessToken, time.Now().UTC())
	if err != nil || validated.AssuranceTier != TierT3 {
		t.Fatalf("session: %+v %v", validated, err)
	}
	validated, err = svc.Validate(session.AccessToken, time.Now().UTC().Add(T3ValidityWindow+time.Second))
	if err != nil || validated.AssuranceTier != TierT1 {
		t.Fatalf("stale T3: %+v %v", validated, err)
	}
	if replay := perform(t, router, "/auth/passkeys/login/finish", token, assertion); replay.Code != 401 {
		t.Fatalf("assertion replay: %d", replay.Code)
	}
	for _, origin := range []string{"https://evil.example", "http://localhost:3000"} {
		token, challenge = ceremonyOptions(t, perform(t, router, "/auth/passkeys/login/begin", "", map[string]string{"citizen_id": citizen, "device_fingerprint": "fp"}))
		wrongKey, _ := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
		// Wrong origin with the correct key, and a forged signature with the right origin.
		signingKey := key
		if origin == "http://localhost:3000" {
			signingKey = wrongKey
		}
		rejected := perform(t, router, "/auth/passkeys/login/finish", token, testAssertion(t, challenge, origin, citizen, signingKey, id))
		if rejected.Code != 401 {
			t.Fatalf("invalid assertion accepted: %d", rejected.Code)
		}
	}
}

func TestPasskeyFailsClosedAndLegacyEndpointsReject(t *testing.T) {
	t.Setenv("WEBAUTHN_RP_ID", "")
	t.Setenv("WEBAUTHN_RP_ORIGIN", "")
	router := NewRouter(testService(), nil, "")
	for _, path := range []string{"/auth/login", "/auth/factors", "/auth/stepup", "/auth/identities/provision"} {
		result := perform(t, router, path, "", map[string]string{"citizen_id": "known-citizen"})
		if result.Code != 401 {
			t.Fatalf("%s = %d", path, result.Code)
		}
	}
	if result := perform(t, router, "/auth/passkeys/login/begin", "", map[string]string{}); result.Code != 503 {
		t.Fatalf("unconfigured verifier = %d", result.Code)
	}
}

func TestCeremonyConsumptionExpiryAndPurpose(t *testing.T) {
	store := NewStore()
	now := time.Now().UTC()
	_ = store.InsertCeremony("grant", Ceremony{CitizenID: newID(), Kind: "enrollment", ExpiresAt: now.Add(time.Minute)})
	if _, err := store.ConsumeCeremony("grant", "login", now); err != ErrUnauthorized {
		t.Fatal("cross-purpose consumption accepted")
	}
	if _, err := store.ConsumeCeremony("grant", "enrollment", now.Add(time.Minute)); err != ErrUnauthorized {
		t.Fatal("expired grant accepted")
	}
}
