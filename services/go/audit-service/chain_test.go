package main

import (
	"strings"
	"testing"
	"time"
)

func TestGenesisHash(t *testing.T) {
	if len(genesisHash) != 64 {
		t.Fatalf("expected genesis hash to be 64 hex chars, got %d", len(genesisHash))
	}
	if strings.Trim(genesisHash, "0") != "" {
		t.Fatalf("expected genesis hash to be all zeros, got %q", genesisHash)
	}
}

func TestComputePayloadHash(t *testing.T) {
	h1, err := computePayloadHash(map[string]any{"a": 1, "b": 2})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if len(h1) != 64 {
		t.Fatalf("expected 64 hex chars, got %d (%q)", len(h1), h1)
	}

	h2, err := computePayloadHash(map[string]any{"b": 2, "a": 1})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if h1 != h2 {
		t.Fatalf("expected deterministic hash regardless of map key order, got %q vs %q", h1, h2)
	}

	h3, err := computePayloadHash(map[string]any{"a": 1, "b": 3})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if h1 == h3 {
		t.Fatalf("expected different payloads to hash differently")
	}
}

func TestComputeRowHash(t *testing.T) {
	createdAt := time.Date(2026, 6, 18, 12, 0, 0, 0, time.UTC)
	base := AuditLogEntry{
		PrevHash:    genesisHash,
		PayloadHash: "deadbeef",
		ActorRef:    "system:test",
		ActionType:  ActionSystemUpdate,
		CreatedAt:   createdAt,
	}

	h1 := computeRowHash(base)
	h2 := computeRowHash(base)
	if h1 != h2 {
		t.Fatalf("expected computeRowHash to be deterministic")
	}
	if len(h1) != 64 {
		t.Fatalf("expected 64 hex chars, got %d", len(h1))
	}

	changed := base
	changed.ActorRef = "system:other"
	if computeRowHash(changed) == h1 {
		t.Fatalf("expected row hash to change when actor_ref changes")
	}

	changed2 := base
	changed2.PrevHash = "1234"
	if computeRowHash(changed2) == h1 {
		t.Fatalf("expected row hash to change when prev_hash changes")
	}
}

func TestComputeSignature(t *testing.T) {
	key1 := []byte("key-one")
	key2 := []byte("key-two")

	s1 := computeSignature("some-row-hash", key1)
	s2 := computeSignature("some-row-hash", key1)
	if s1 != s2 {
		t.Fatalf("expected deterministic signature for same key+hash")
	}
	if len(s1) != 64 {
		t.Fatalf("expected 64 hex chars, got %d", len(s1))
	}

	s3 := computeSignature("some-row-hash", key2)
	if s1 == s3 {
		t.Fatalf("expected signature to differ across signing keys")
	}
}

func TestBuildEntry(t *testing.T) {
	key := []byte("signing-key")
	createdAt := time.Date(2026, 6, 18, 12, 0, 0, 0, time.UTC)

	entry, err := buildEntry("id-1", ActionRuleChange, "system:test", map[string]any{"x": 1}, genesisHash, createdAt, key)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if entry.ID != "id-1" {
		t.Fatalf("expected id to round-trip, got %q", entry.ID)
	}
	if entry.PrevHash != genesisHash {
		t.Fatalf("expected prev_hash to round-trip, got %q", entry.PrevHash)
	}
	if len(entry.PayloadHash) != 64 {
		t.Fatalf("expected payload_hash to be 64 hex chars, got %d", len(entry.PayloadHash))
	}

	wantRowHash := computeRowHash(entry)
	wantSig := computeSignature(wantRowHash, key)
	if entry.Signature != wantSig {
		t.Fatalf("expected signature %q, got %q", wantSig, entry.Signature)
	}
}

func TestGenerateIDUnique(t *testing.T) {
	seen := map[string]bool{}
	for i := 0; i < 100; i++ {
		id := generateID()
		if seen[id] {
			t.Fatalf("expected unique ids, got duplicate %q", id)
		}
		seen[id] = true
	}
}
