package main

import (
	"bytes"
	"crypto/rand"
	"testing"
)

func randomSecret(t *testing.T, n int) []byte {
	t.Helper()
	b := make([]byte, n)
	if _, err := rand.Read(b); err != nil {
		t.Fatalf("rand.Read: %v", err)
	}
	return b
}

func TestShamirSplitCombineExactThreshold(t *testing.T) {
	secret := randomSecret(t, 32)
	shares, err := shamirSplit(secret, 5, 3)
	if err != nil {
		t.Fatalf("shamirSplit: %v", err)
	}
	if len(shares) != 5 {
		t.Fatalf("got %d shares, want 5", len(shares))
	}

	got, err := shamirCombine(shares[:3])
	if err != nil {
		t.Fatalf("shamirCombine: %v", err)
	}
	if !bytes.Equal(got, secret) {
		t.Fatalf("reconstructed secret does not match original")
	}
}

func TestShamirCombineAnyKOfNSubset(t *testing.T) {
	secret := randomSecret(t, 32)
	shares, err := shamirSplit(secret, 5, 3)
	if err != nil {
		t.Fatalf("shamirSplit: %v", err)
	}

	subsets := [][]Share{
		{shares[0], shares[1], shares[2]},
		{shares[1], shares[3], shares[4]},
		{shares[0], shares[2], shares[4]},
	}
	for i, subset := range subsets {
		got, err := shamirCombine(subset)
		if err != nil {
			t.Fatalf("subset %d: shamirCombine: %v", i, err)
		}
		if !bytes.Equal(got, secret) {
			t.Fatalf("subset %d: reconstructed secret does not match original", i)
		}
	}
}

func TestShamirCombineWithFullShareSet(t *testing.T) {
	secret := randomSecret(t, 32)
	shares, err := shamirSplit(secret, 5, 3)
	if err != nil {
		t.Fatalf("shamirSplit: %v", err)
	}
	got, err := shamirCombine(shares)
	if err != nil {
		t.Fatalf("shamirCombine: %v", err)
	}
	if !bytes.Equal(got, secret) {
		t.Fatalf("reconstructed secret with all shares does not match original")
	}
}

func TestShamirCombineBelowThresholdDoesNotReconstruct(t *testing.T) {
	secret := randomSecret(t, 32)
	shares, err := shamirSplit(secret, 5, 3)
	if err != nil {
		t.Fatalf("shamirSplit: %v", err)
	}

	// Raw Shamir has no error detection: combining with fewer than the
	// threshold produces *some* output, but it must not silently equal the
	// original secret.
	got, err := shamirCombine(shares[:2])
	if err != nil {
		t.Fatalf("shamirCombine: %v", err)
	}
	if bytes.Equal(got, secret) {
		t.Fatalf("combining K-1 shares must not reconstruct the original secret")
	}
}

func TestShamirSplitNLessThanKErrors(t *testing.T) {
	secret := randomSecret(t, 32)
	if _, err := shamirSplit(secret, 2, 3); err == nil {
		t.Fatal("expected error when n < k")
	}
}

func TestShamirSplitInvalidParams(t *testing.T) {
	secret := randomSecret(t, 32)
	cases := []struct {
		name string
		n, k int
	}{
		{"zero k", 5, 0},
		{"zero n", 0, 3},
		{"negative k", 5, -1},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			if _, err := shamirSplit(secret, c.n, c.k); err == nil {
				t.Fatalf("expected error for n=%d k=%d", c.n, c.k)
			}
		})
	}
}

func TestShamirCombineDuplicateSharesErrors(t *testing.T) {
	secret := randomSecret(t, 32)
	shares, err := shamirSplit(secret, 5, 3)
	if err != nil {
		t.Fatalf("shamirSplit: %v", err)
	}
	dup := []Share{shares[0], shares[0], shares[1]}
	if _, err := shamirCombine(dup); err == nil {
		t.Fatal("expected error combining duplicate x-coordinate shares")
	}
}

func TestShamirCombineMismatchedLengthSharesErrors(t *testing.T) {
	bad := []Share{
		{X: 1, Y: []byte{1, 2, 3}},
		{X: 2, Y: []byte{1, 2}},
		{X: 3, Y: []byte{1, 2, 3}},
	}
	if _, err := shamirCombine(bad); err == nil {
		t.Fatal("expected error combining mismatched-length shares")
	}
}

func TestShamirCombineEmptyErrors(t *testing.T) {
	if _, err := shamirCombine(nil); err == nil {
		t.Fatal("expected error combining zero shares")
	}
}

func TestShamirSplitDifferentSecretsDifferentShares(t *testing.T) {
	secret := randomSecret(t, 32)
	sharesA, err := shamirSplit(secret, 5, 3)
	if err != nil {
		t.Fatalf("shamirSplit: %v", err)
	}
	sharesB, err := shamirSplit(secret, 5, 3)
	if err != nil {
		t.Fatalf("shamirSplit: %v", err)
	}
	// Random coefficients mean re-splitting the same secret should produce
	// different share values (with overwhelming probability).
	identical := true
	for i := range sharesA {
		if !bytes.Equal(sharesA[i].Y, sharesB[i].Y) {
			identical = false
			break
		}
	}
	if identical {
		t.Fatal("expected different random shares across independent splits")
	}
}

func TestShamirSplitSingleByteSecret(t *testing.T) {
	secret := []byte{0x42}
	shares, err := shamirSplit(secret, 5, 3)
	if err != nil {
		t.Fatalf("shamirSplit: %v", err)
	}
	got, err := shamirCombine(shares[1:4])
	if err != nil {
		t.Fatalf("shamirCombine: %v", err)
	}
	if !bytes.Equal(got, secret) {
		t.Fatalf("got %x, want %x", got, secret)
	}
}
