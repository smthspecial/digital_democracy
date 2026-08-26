package main

import "testing"

func TestVerifyChainIntegrityHealthyChain(t *testing.T) {
	s := NewStore()
	for i := 0; i < 5; i++ {
		if _, err := s.Append(ActionSystemUpdate, "system:test", map[string]any{"n": i}, ""); err != nil {
			t.Fatalf("unexpected error: %v", err)
		}
	}

	valid, brokenAt, err := s.VerifyChainIntegrity()
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if !valid {
		t.Fatalf("expected healthy chain to verify as valid, broke at %q", brokenAt)
	}
	if brokenAt != "" {
		t.Fatalf("expected empty broken_at on valid chain, got %q", brokenAt)
	}
}

func TestVerifyChainIntegrityEmptyChain(t *testing.T) {
	s := NewStore()
	valid, _, err := s.VerifyChainIntegrity()
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if !valid {
		t.Fatalf("expected empty chain to verify as valid")
	}
}

func TestVerifyChainIntegrityDetectsTamperedField(t *testing.T) {
	s := NewStore()
	if _, err := s.Append(ActionSystemUpdate, "system:test", map[string]any{"n": 1}, ""); err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	e2, err := s.Append(ActionSystemUpdate, "system:test", map[string]any{"n": 2}, "")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if _, err := s.Append(ActionSystemUpdate, "system:test", map[string]any{"n": 3}, ""); err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	// Directly mutate the second entry's stored field -- this is a
	// package-internal test, not a real mutation API on Store.
	for i := range s.entries {
		if s.entries[i].ID == e2.ID {
			s.entries[i].ActorRef = "tampered-actor"
		}
	}

	valid, brokenAt, err := s.VerifyChainIntegrity()
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if valid {
		t.Fatalf("expected tampered chain to be detected as invalid")
	}
	if brokenAt != e2.ID {
		t.Fatalf("expected break to be detected at tampered entry %q, got %q", e2.ID, brokenAt)
	}
}
