package main

import "errors"

// GF(256) byte-oriented finite field arithmetic using the AES/Rijndael
// irreducible polynomial x^8+x^4+x^3+x+1 (0x11B), used for Shamir's Secret
// Sharing in shamir.go. Addition/subtraction in this field is XOR.

var (
	gfExpTable [512]byte
	gfLogTable [256]byte
)

func init() {
	x := byte(1)
	for i := 0; i < 255; i++ {
		gfExpTable[i] = x
		gfLogTable[x] = byte(i)
		x = gfMulShiftXor(x, 0x03)
	}
	for i := 255; i < 512; i++ {
		gfExpTable[i] = gfExpTable[i-255]
	}
}

// gfMulShiftXor is the reference peasant-multiplication implementation of
// GF(256) multiplication, used both directly and to build the log/exp
// tables that gfMul uses for speed.
func gfMulShiftXor(a, b byte) byte {
	var p byte
	for i := 0; i < 8; i++ {
		if b&1 != 0 {
			p ^= a
		}
		hiBitSet := a & 0x80
		a <<= 1
		if hiBitSet != 0 {
			a ^= 0x1B
		}
		b >>= 1
	}
	return p
}

func gfMul(a, b byte) byte {
	if a == 0 || b == 0 {
		return 0
	}
	return gfExpTable[int(gfLogTable[a])+int(gfLogTable[b])]
}

func gfDiv(a, b byte) (byte, error) {
	if b == 0 {
		return 0, errors.New("gf256: division by zero")
	}
	if a == 0 {
		return 0, nil
	}
	diff := int(gfLogTable[a]) - int(gfLogTable[b])
	if diff < 0 {
		diff += 255
	}
	return gfExpTable[diff], nil
}
