package main

import (
	"testing"
	"time"
)

func TestDelegationActiveAt(t *testing.T) {
	base := time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)
	future := base.Add(24 * time.Hour)
	past := base.Add(-24 * time.Hour)

	cases := []struct {
		name      string
		expiresAt time.Time
		revokedAt *time.Time
		at        time.Time
		want      bool
	}{
		{"active, not expired, not revoked", future, nil, base, true},
		{"expired exactly at boundary is not active", base, nil, base, false},
		{"expired in the past", past, nil, base, false},
		{"revoked before at", future, &past, base, false},
		{"revoked exactly at at", future, &base, base, false},
		{"revoked after at (not yet effective)", future, &future, base, true},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			d := &Delegation{ExpiresAt: tc.expiresAt, RevokedAt: tc.revokedAt}
			got := d.activeAt(tc.at)
			if got != tc.want {
				t.Fatalf("activeAt(%v) = %v, want %v", tc.at, got, tc.want)
			}
		})
	}
}

func TestNewIDIsUniqueAndNonEmpty(t *testing.T) {
	a := newID()
	b := newID()
	if a == "" || b == "" {
		t.Fatalf("expected non-empty ids, got %q and %q", a, b)
	}
	if a == b {
		t.Fatalf("expected distinct ids, got same value %q twice", a)
	}
}
