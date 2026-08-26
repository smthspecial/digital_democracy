package main

import (
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"strings"
	"time"
)

// genesisHash is the fixed prev_hash of the first entry ever appended to a
// chain: 64 hex chars of zero, i.e. the same shape as a real sha256 digest.
const genesisHash = "0000000000000000000000000000000000000000000000000000000000000000"

// computePayloadHash hashes the JSON encoding of an arbitrary payload.
// encoding/json sorts map keys and uses fixed struct field order, which is
// canonical enough for hash-chain purposes given the same Go value in.
func computePayloadHash(payload any) (string, error) {
	data, err := json.Marshal(payload)
	if err != nil {
		return "", err
	}
	sum := sha256.Sum256(data)
	return hex.EncodeToString(sum[:]), nil
}

// computeRowHash is an entry's own row hash, derived on the fly from its
// stored fields rather than persisted as a column -- this is deliberate:
// TBL-034 has no "row_hash" column, only prev_hash/payload_hash/signature.
// Canonical concatenation (documented once, here): prev_hash, payload_hash,
// actor_ref, action_type, created_at (RFC3339), each joined by "|".
func computeRowHash(e AuditLogEntry) string {
	parts := strings.Join([]string{
		e.PrevHash,
		e.PayloadHash,
		e.ActorRef,
		string(e.ActionType),
		e.CreatedAt.UTC().Format(time.RFC3339),
	}, "|")
	sum := sha256.Sum256([]byte(parts))
	return hex.EncodeToString(sum[:])
}

// computeSignature is a service-level signature over a row hash. A real
// deployment would sign with an asymmetric key held in a KMS so the public
// can verify without holding the private key; HMAC with a process-local
// symmetric key is a stand-in that still detects tampering internally.
func computeSignature(rowHash string, signingKey []byte) string {
	mac := hmac.New(sha256.New, signingKey)
	mac.Write([]byte(rowHash))
	return hex.EncodeToString(mac.Sum(nil))
}

// buildEntry constructs a fully-formed, signed AuditLogEntry that claims to
// link to prevHash. It is pure (no store access): the caller decides
// whether prevHash is actually the chain's current tip.
func buildEntry(id string, actionType ActionType, actorRef string, payload any, prevHash string, createdAt time.Time, signingKey []byte) (AuditLogEntry, error) {
	payloadHash, err := computePayloadHash(payload)
	if err != nil {
		return AuditLogEntry{}, err
	}
	entry := AuditLogEntry{
		ID:          id,
		ActionType:  actionType,
		ActorRef:    actorRef,
		PayloadHash: payloadHash,
		PrevHash:    prevHash,
		CreatedAt:   createdAt,
	}
	rowHash := computeRowHash(entry)
	entry.Signature = computeSignature(rowHash, signingKey)
	return entry, nil
}

// generateID returns a random UUIDv4-shaped identifier. Stdlib-only stand-in
// for a real UUID library.
func generateID() string {
	b := make([]byte, 16)
	if _, err := rand.Read(b); err != nil {
		panic(err)
	}
	b[6] = (b[6] & 0x0f) | 0x40
	b[8] = (b[8] & 0x3f) | 0x80
	return hex.EncodeToString(b[0:4]) + "-" +
		hex.EncodeToString(b[4:6]) + "-" +
		hex.EncodeToString(b[6:8]) + "-" +
		hex.EncodeToString(b[8:10]) + "-" +
		hex.EncodeToString(b[10:16])
}

// generateSigningKey returns a fresh random HMAC key, generated once at
// process start and held only in memory (never persisted).
func generateSigningKey() []byte {
	key := make([]byte, 32)
	if _, err := rand.Read(key); err != nil {
		panic(err)
	}
	return key
}
