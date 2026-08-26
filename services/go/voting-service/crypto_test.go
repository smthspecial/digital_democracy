package main

import (
	"bytes"
	"testing"
)

func TestGenerateAESKeyLengthAndUniqueness(t *testing.T) {
	k1, err := generateAESKey()
	if err != nil {
		t.Fatalf("generateAESKey: %v", err)
	}
	if len(k1) != 32 {
		t.Fatalf("key length = %d, want 32", len(k1))
	}
	k2, err := generateAESKey()
	if err != nil {
		t.Fatalf("generateAESKey: %v", err)
	}
	if bytes.Equal(k1, k2) {
		t.Fatal("expected two independently generated keys to differ")
	}
}

func TestEncryptDecryptAESGCMRoundTrip(t *testing.T) {
	key, err := generateAESKey()
	if err != nil {
		t.Fatalf("generateAESKey: %v", err)
	}
	plaintext := []byte("opt1,opt3")

	ciphertext, nonce, err := encryptAESGCM(key, plaintext)
	if err != nil {
		t.Fatalf("encryptAESGCM: %v", err)
	}
	if bytes.Equal(ciphertext, plaintext) {
		t.Fatal("ciphertext must not equal plaintext")
	}
	if len(nonce) == 0 {
		t.Fatal("expected a non-empty nonce")
	}

	got, err := decryptAESGCM(key, nonce, ciphertext)
	if err != nil {
		t.Fatalf("decryptAESGCM: %v", err)
	}
	if !bytes.Equal(got, plaintext) {
		t.Fatalf("got %q, want %q", got, plaintext)
	}
}

func TestEncryptAESGCMFreshNoncePerCall(t *testing.T) {
	key, err := generateAESKey()
	if err != nil {
		t.Fatalf("generateAESKey: %v", err)
	}
	_, nonce1, err := encryptAESGCM(key, []byte("choice-a"))
	if err != nil {
		t.Fatalf("encryptAESGCM: %v", err)
	}
	_, nonce2, err := encryptAESGCM(key, []byte("choice-a"))
	if err != nil {
		t.Fatalf("encryptAESGCM: %v", err)
	}
	if bytes.Equal(nonce1, nonce2) {
		t.Fatal("expected fresh nonce per encryption call")
	}
}

func TestDecryptAESGCMWrongKeyFails(t *testing.T) {
	key, _ := generateAESKey()
	wrongKey, _ := generateAESKey()
	ciphertext, nonce, err := encryptAESGCM(key, []byte("secret choice"))
	if err != nil {
		t.Fatalf("encryptAESGCM: %v", err)
	}
	if _, err := decryptAESGCM(wrongKey, nonce, ciphertext); err == nil {
		t.Fatal("expected decryption with wrong key to fail")
	}
}

func TestDecryptAESGCMTamperedCiphertextFails(t *testing.T) {
	key, _ := generateAESKey()
	ciphertext, nonce, err := encryptAESGCM(key, []byte("secret choice"))
	if err != nil {
		t.Fatalf("encryptAESGCM: %v", err)
	}
	tampered := append([]byte(nil), ciphertext...)
	tampered[0] ^= 0xFF
	if _, err := decryptAESGCM(key, nonce, tampered); err == nil {
		t.Fatal("expected decryption of tampered ciphertext to fail")
	}
}

func TestEncryptAESGCMInvalidKeySizeErrors(t *testing.T) {
	if _, _, err := encryptAESGCM([]byte("too-short"), []byte("x")); err == nil {
		t.Fatal("expected error for invalid AES key size")
	}
}

func TestRandomHexLengthAndUniqueness(t *testing.T) {
	a, err := randomHex(8)
	if err != nil {
		t.Fatalf("randomHex: %v", err)
	}
	if len(a) != 16 {
		t.Fatalf("randomHex(8) length = %d, want 16", len(a))
	}
	b, err := randomHex(8)
	if err != nil {
		t.Fatalf("randomHex: %v", err)
	}
	if a == b {
		t.Fatal("expected two random hex strings to differ")
	}
}

func TestNewIDLooksLikeUUIDv4(t *testing.T) {
	id := newID()
	if len(id) != 36 {
		t.Fatalf("newID() length = %d, want 36, got %q", len(id), id)
	}
	if id[14] != '4' {
		t.Fatalf("newID() version nibble = %q, want '4' at position 14 (%q)", id[14], id)
	}
	other := newID()
	if id == other {
		t.Fatal("expected two generated IDs to differ")
	}
}

func TestSHA256HexDeterministicAndDistinct(t *testing.T) {
	h1 := sha256Hex("secret-a")
	h2 := sha256Hex("secret-a")
	if h1 != h2 {
		t.Fatal("expected sha256Hex to be deterministic for the same input")
	}
	h3 := sha256Hex("secret-b")
	if h1 == h3 {
		t.Fatal("expected different inputs to hash differently")
	}
	if len(h1) != 64 {
		t.Fatalf("sha256Hex length = %d, want 64", len(h1))
	}
}
