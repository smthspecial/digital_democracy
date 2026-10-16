package audit

import (
	"crypto/ed25519"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"os"
)

// A configured seed is stable across replicas/restarts. An ephemeral key serves
// disposable in-memory runs; main requires configuration for persistent stores.
func newSigningKey() ed25519.PrivateKey {
	if secret := os.Getenv("AUDIT_SIGNING_KEY"); secret != "" {
		seed := sha256.Sum256([]byte(secret))
		return ed25519.NewKeyFromSeed(seed[:])
	}
	_, private, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		panic(err)
	}
	return private
}
func signEntry(key ed25519.PrivateKey, id, hash string) string {
	return "ed25519:" + base64.RawURLEncoding.EncodeToString(ed25519.Sign(key, []byte(id+"\n"+hash)))
}
func validEntrySignature(key ed25519.PrivateKey, e *AuditEntry) bool {
	const prefix = "ed25519:"
	if len(e.Signature) <= len(prefix) || e.Signature[:len(prefix)] != prefix {
		return false
	}
	sig, err := base64.RawURLEncoding.DecodeString(e.Signature[len(prefix):])
	return err == nil && ed25519.Verify(key.Public().(ed25519.PublicKey), []byte(e.ID+"\n"+e.Hash), sig)
}

func (st *MemoryStore) PublicKey() string {
	return base64.RawURLEncoding.EncodeToString(st.signingKey.Public().(ed25519.PublicKey))
}
func (st *PGStore) PublicKey() string {
	return base64.RawURLEncoding.EncodeToString(st.signingKey.Public().(ed25519.PublicKey))
}
