package main

import (
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/sha256"
	"testing"
	"time"
)

// RFC 6238 Appendix B test vector, SHA1 case: shared secret "12345678901234567890"
// ASCII, base32 encoded, 30s step, 8-digit codes truncated here to the service's
// 6-digit format (the RFC vector's low-order 6 digits of the 8-digit code match
// what a 6-digit truncation produces, since the dynamic truncation algorithm is
// the same modulo a smaller power of ten).
func TestTOTPRFC6238Vector(t *testing.T) {
	secret := totpBase32Encoding.EncodeToString([]byte("12345678901234567890"))

	cases := []struct {
		unix int64
		code string
	}{
		{59, "287082"},
		{1111111109, "081804"},
		{1111111111, "050471"},
		{1234567890, "005924"},
		{2000000000, "279037"},
	}

	for _, c := range cases {
		got, err := totpCode(secret, time.Unix(c.unix, 0).UTC())
		if err != nil {
			t.Fatalf("totpCode(%d): unexpected error: %v", c.unix, err)
		}
		if got != c.code {
			t.Errorf("totpCode(%d) = %q, want %q", c.unix, got, c.code)
		}
	}
}

func TestTOTPValidateDriftWindow(t *testing.T) {
	secret := totpGenerateSecret()
	base := time.Unix(1_700_000_000, 0).UTC()

	code, err := totpCode(secret, base)
	if err != nil {
		t.Fatalf("totpCode: unexpected error: %v", err)
	}

	if !totpValidate(secret, code, base) {
		t.Errorf("expected code valid at generation time")
	}
	if !totpValidate(secret, code, base.Add(30*time.Second)) {
		t.Errorf("expected code valid one step later (+30s, within drift window)")
	}
	if !totpValidate(secret, code, base.Add(-30*time.Second)) {
		t.Errorf("expected code valid one step earlier (-30s, within drift window)")
	}
	if totpValidate(secret, code, base.Add(90*time.Second)) {
		t.Errorf("expected code invalid three steps later (+90s, outside drift window)")
	}
	if totpValidate(secret, code, base.Add(-90*time.Second)) {
		t.Errorf("expected code invalid three steps earlier (-90s, outside drift window)")
	}
	if totpValidate(secret, "000000", base) {
		t.Errorf("expected wrong code to be rejected")
	}
}

func TestPasskeySignatureVerification(t *testing.T) {
	priv, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatalf("GenerateKey: %v", err)
	}
	pubDER, err := marshalECDSAPublicKey(&priv.PublicKey)
	if err != nil {
		t.Fatalf("marshalECDSAPublicKey: %v", err)
	}

	challenge := generatePasskeyChallenge()
	if len(challenge) == 0 {
		t.Fatalf("expected non-empty challenge")
	}
	hash := sha256.Sum256(challenge)
	sig, err := ecdsa.SignASN1(rand.Reader, priv, hash[:])
	if err != nil {
		t.Fatalf("SignASN1: %v", err)
	}

	if !verifyPasskeySignature(pubDER, challenge, sig) {
		t.Errorf("expected valid signature to verify")
	}

	wrongPriv, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatalf("GenerateKey: %v", err)
	}
	wrongSig, err := ecdsa.SignASN1(rand.Reader, wrongPriv, hash[:])
	if err != nil {
		t.Fatalf("SignASN1: %v", err)
	}
	if verifyPasskeySignature(pubDER, challenge, wrongSig) {
		t.Errorf("expected signature from wrong private key to be rejected")
	}
}

func TestCosineSimilarity(t *testing.T) {
	tests := []struct {
		name string
		a, b []float64
		want float64
	}{
		{"identical", []float64{1, 0, 0}, []float64{1, 0, 0}, 1},
		{"orthogonal", []float64{1, 0}, []float64{0, 1}, 0},
		{"opposite", []float64{1, 0}, []float64{-1, 0}, -1},
		{"zero vector a", []float64{0, 0}, []float64{1, 1}, 0},
		{"mismatched length", []float64{1, 2, 3}, []float64{1, 2}, 0},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			got := cosineSimilarity(tc.a, tc.b)
			if diff := got - tc.want; diff > 1e-9 || diff < -1e-9 {
				t.Errorf("cosineSimilarity(%v, %v) = %v, want %v", tc.a, tc.b, got, tc.want)
			}
		})
	}
}

func TestEncryptorRoundTrip(t *testing.T) {
	enc, err := newEncryptor()
	if err != nil {
		t.Fatalf("newEncryptor: %v", err)
	}
	plaintext := []byte("super-secret-totp-seed")

	ciphertext, err := enc.encrypt(plaintext)
	if err != nil {
		t.Fatalf("encrypt: %v", err)
	}
	if string(ciphertext) == string(plaintext) {
		t.Fatalf("ciphertext must not equal plaintext")
	}

	got, err := enc.decrypt(ciphertext)
	if err != nil {
		t.Fatalf("decrypt: %v", err)
	}
	if string(got) != string(plaintext) {
		t.Errorf("round trip = %q, want %q", got, plaintext)
	}

	otherEnc, err := newEncryptor()
	if err != nil {
		t.Fatalf("newEncryptor: %v", err)
	}
	if _, err := otherEnc.decrypt(ciphertext); err == nil {
		t.Errorf("expected decrypt with wrong key to fail")
	}
}

func TestFloatsBytesRoundTrip(t *testing.T) {
	vals := []float64{0.1, -2.5, 3.999, 0}
	got := bytesToFloats(floatsToBytes(vals))
	if len(got) != len(vals) {
		t.Fatalf("length mismatch: got %d, want %d", len(got), len(vals))
	}
	for i := range vals {
		if got[i] != vals[i] {
			t.Errorf("index %d: got %v, want %v", i, got[i], vals[i])
		}
	}
}

func TestGenerateTokenPair(t *testing.T) {
	plain, hash, err := generateTokenPair()
	if err != nil {
		t.Fatalf("generateTokenPair: %v", err)
	}
	if plain == "" || hash == "" {
		t.Fatalf("expected non-empty plain and hash")
	}
	if hash != hashToken(plain) {
		t.Errorf("hash does not match hashToken(plain)")
	}
	plain2, _, err := generateTokenPair()
	if err != nil {
		t.Fatalf("generateTokenPair: %v", err)
	}
	if plain == plain2 {
		t.Errorf("expected distinct tokens across calls")
	}
}
