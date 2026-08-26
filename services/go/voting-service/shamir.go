package main

import (
	"crypto/rand"
	"errors"
	"fmt"
)

// Share is one point on the degree-(k-1) polynomial encoding a secret byte
// string, per byte of the secret (Y has the same length as the secret).
type Share struct {
	X byte
	Y []byte
}

// shamirSplit splits secret into n shares such that any k of them
// reconstruct it exactly via shamirCombine, using Shamir's Secret Sharing
// over GF(256), one independent polynomial per byte of the secret.
func shamirSplit(secret []byte, n, k int) ([]Share, error) {
	if k < 1 {
		return nil, fmt.Errorf("shamir: threshold k must be >= 1, got %d", k)
	}
	if n < k {
		return nil, fmt.Errorf("shamir: n (%d) must be >= k (%d)", n, k)
	}
	if n > 255 {
		return nil, errors.New("shamir: n must be <= 255")
	}
	if len(secret) == 0 {
		return nil, errors.New("shamir: secret must not be empty")
	}

	shares := make([]Share, n)
	for i := range shares {
		shares[i] = Share{X: byte(i + 1), Y: make([]byte, len(secret))}
	}

	coeffs := make([]byte, k)
	randBuf := make([]byte, k-1)
	for byteIdx, secretByte := range secret {
		coeffs[0] = secretByte
		if k > 1 {
			if _, err := rand.Read(randBuf); err != nil {
				return nil, fmt.Errorf("shamir: generate coefficients: %w", err)
			}
			copy(coeffs[1:], randBuf)
		}
		for i := range shares {
			shares[i].Y[byteIdx] = evalPoly(coeffs, shares[i].X)
		}
	}
	return shares, nil
}

// evalPoly evaluates the polynomial with the given coefficients (lowest
// degree first) at x, over GF(256), via Horner's method.
func evalPoly(coeffs []byte, x byte) byte {
	var result byte
	for i := len(coeffs) - 1; i >= 0; i-- {
		result = gfMul(result, x) ^ coeffs[i]
	}
	return result
}

// shamirCombine reconstructs the secret from the given shares via Lagrange
// interpolation at x=0. It has no way to know the original threshold k, so
// it always produces output; passing fewer than k shares silently yields
// the wrong secret rather than an error (this is an inherent property of
// raw Shamir sharing, not a bug).
func shamirCombine(shares []Share) ([]byte, error) {
	if len(shares) == 0 {
		return nil, errors.New("shamir: at least one share is required")
	}

	secretLen := len(shares[0].Y)
	seenX := make(map[byte]bool, len(shares))
	for _, s := range shares {
		if len(s.Y) != secretLen {
			return nil, errors.New("shamir: shares have mismatched lengths")
		}
		if seenX[s.X] {
			return nil, fmt.Errorf("shamir: duplicate share x-coordinate %d", s.X)
		}
		seenX[s.X] = true
	}

	secret := make([]byte, secretLen)
	for byteIdx := 0; byteIdx < secretLen; byteIdx++ {
		y, err := lagrangeInterpolateZero(shares, byteIdx)
		if err != nil {
			return nil, err
		}
		secret[byteIdx] = y
	}
	return secret, nil
}

func lagrangeInterpolateZero(shares []Share, byteIdx int) (byte, error) {
	var result byte
	for i, si := range shares {
		num := byte(1)
		den := byte(1)
		for j, sj := range shares {
			if i == j {
				continue
			}
			num = gfMul(num, sj.X)
			den = gfMul(den, sj.X^si.X)
		}
		term, err := gfDiv(num, den)
		if err != nil {
			return 0, fmt.Errorf("shamir: interpolation failed: %w", err)
		}
		result ^= gfMul(si.Y[byteIdx], term)
	}
	return result, nil
}
