package main

import "testing"

func TestGFMulIdentities(t *testing.T) {
	for x := 0; x < 256; x++ {
		a := byte(x)
		if got := gfMul(a, 0); got != 0 {
			t.Fatalf("gfMul(%d, 0) = %d, want 0", a, got)
		}
		if got := gfMul(a, 1); got != a {
			t.Fatalf("gfMul(%d, 1) = %d, want %d", a, got, a)
		}
	}
}

func TestGFMulCommutative(t *testing.T) {
	for a := 0; a < 256; a += 7 {
		for b := 0; b < 256; b += 11 {
			if gfMul(byte(a), byte(b)) != gfMul(byte(b), byte(a)) {
				t.Fatalf("gfMul(%d,%d) != gfMul(%d,%d)", a, b, b, a)
			}
		}
	}
}

func TestGFMulKnownValue(t *testing.T) {
	// 0x53 * 0xCA = 0x01 is a well-known AES field identity (0xCA is the
	// multiplicative inverse of 0x53).
	if got := gfMul(0x53, 0xCA); got != 0x01 {
		t.Fatalf("gfMul(0x53, 0xCA) = %#x, want 0x01", got)
	}
}

func TestGFDivByZeroErrors(t *testing.T) {
	if _, err := gfDiv(5, 0); err == nil {
		t.Fatal("expected error dividing by zero in GF(256)")
	}
}

func TestGFDivZeroNumerator(t *testing.T) {
	got, err := gfDiv(0, 42)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if got != 0 {
		t.Fatalf("gfDiv(0, 42) = %d, want 0", got)
	}
}

func TestGFDivRoundTrip(t *testing.T) {
	for a := 1; a < 256; a++ {
		for b := 1; b < 256; b += 17 {
			product := gfMul(byte(a), byte(b))
			quotient, err := gfDiv(product, byte(b))
			if err != nil {
				t.Fatalf("unexpected error: %v", err)
			}
			if quotient != byte(a) {
				t.Fatalf("(%d*%d)/%d = %d, want %d", a, b, b, quotient, a)
			}
		}
	}
}

func TestGFMulTableMatchesShiftAndXor(t *testing.T) {
	for a := 0; a < 256; a++ {
		for b := 0; b < 256; b += 13 {
			want := gfMulShiftXor(byte(a), byte(b))
			got := gfMul(byte(a), byte(b))
			if got != want {
				t.Fatalf("gfMul(%d,%d) = %d, want %d (shift-and-xor reference)", a, b, got, want)
			}
		}
	}
}
