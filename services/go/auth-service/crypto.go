package main

import (
	"crypto/aes"
	"crypto/cipher"
	"crypto/ecdsa"
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha1"
	"crypto/sha256"
	"crypto/x509"
	"encoding/base32"
	"encoding/binary"
	"encoding/hex"
	"errors"
	"fmt"
	"math"
	"strings"
	"time"
)

// --- TOTP (RFC 6238), HMAC-SHA1, 30s step, 6 digits, ±1 step drift window ---

const (
	totpDigits      = 6
	totpPeriod      = 30 * time.Second
	totpDriftSteps  = 1
	totpSecretBytes = 20 // 160-bit key, standard for HMAC-SHA1
)

var totpBase32Encoding = base32.StdEncoding.WithPadding(base32.NoPadding)

func totpGenerateSecret() string {
	buf := make([]byte, totpSecretBytes)
	_, _ = rand.Read(buf)
	return totpBase32Encoding.EncodeToString(buf)
}

func totpCode(secretBase32 string, t time.Time) (string, error) {
	key, err := totpBase32Encoding.DecodeString(strings.ToUpper(secretBase32))
	if err != nil {
		return "", fmt.Errorf("invalid totp secret: %w", err)
	}
	counter := uint64(t.Unix() / int64(totpPeriod.Seconds()))
	return hotp(key, counter), nil
}

func hotp(key []byte, counter uint64) string {
	buf := make([]byte, 8)
	binary.BigEndian.PutUint64(buf, counter)
	mac := hmac.New(sha1.New, key)
	mac.Write(buf)
	sum := mac.Sum(nil)

	offset := sum[len(sum)-1] & 0x0f
	binCode := (uint32(sum[offset]&0x7f) << 24) |
		(uint32(sum[offset+1]) << 16) |
		(uint32(sum[offset+2]) << 8) |
		uint32(sum[offset+3])

	mod := uint32(1)
	for i := 0; i < totpDigits; i++ {
		mod *= 10
	}
	return fmt.Sprintf("%0*d", totpDigits, binCode%mod)
}

func totpValidate(secretBase32, code string, t time.Time) bool {
	for i := -totpDriftSteps; i <= totpDriftSteps; i++ {
		candidate, err := totpCode(secretBase32, t.Add(time.Duration(i)*totpPeriod))
		if err != nil {
			return false
		}
		if hmac.Equal([]byte(candidate), []byte(code)) {
			return true
		}
	}
	return false
}

// --- Passkey: ECDSA P-256 challenge/response ---
// Full WebAuthn (COSE key format, CBOR attestation objects, origin/RP-ID binding)
// is out of scope; this captures the core signature-verification guarantee.

func generatePasskeyChallenge() []byte {
	buf := make([]byte, 32)
	_, _ = rand.Read(buf)
	return buf
}

func marshalECDSAPublicKey(pub *ecdsa.PublicKey) ([]byte, error) {
	return x509.MarshalPKIXPublicKey(pub)
}

func verifyPasskeySignature(pubKeyDER, challenge, signature []byte) bool {
	pub, err := x509.ParsePKIXPublicKey(pubKeyDER)
	if err != nil {
		return false
	}
	ecdsaPub, ok := pub.(*ecdsa.PublicKey)
	if !ok {
		return false
	}
	hash := sha256.Sum256(challenge)
	return ecdsa.VerifyASN1(ecdsaPub, hash[:], signature)
}

// --- Facial biometric: embedding cosine similarity ---

const facialConfidenceThreshold = 0.85

func cosineSimilarity(a, b []float64) float64 {
	if len(a) != len(b) || len(a) == 0 {
		return 0
	}
	var dot, magA, magB float64
	for i := range a {
		dot += a[i] * b[i]
		magA += a[i] * a[i]
		magB += b[i] * b[i]
	}
	if magA == 0 || magB == 0 {
		return 0
	}
	return dot / (math.Sqrt(magA) * math.Sqrt(magB))
}

func floatsToBytes(vals []float64) []byte {
	buf := make([]byte, 8*len(vals))
	for i, v := range vals {
		binary.BigEndian.PutUint64(buf[i*8:], math.Float64bits(v))
	}
	return buf
}

func bytesToFloats(b []byte) []float64 {
	n := len(b) / 8
	out := make([]float64, n)
	for i := 0; i < n; i++ {
		out[i] = math.Float64frombits(binary.BigEndian.Uint64(b[i*8 : i*8+8]))
	}
	return out
}

// --- AES-256-GCM encryption at rest ---
// Real deployment sources this key from a KMS; here it's generated once at
// process start and held only in memory.

type encryptor struct {
	key []byte
}

func newEncryptor() (*encryptor, error) {
	key := make([]byte, 32)
	if _, err := rand.Read(key); err != nil {
		return nil, err
	}
	return &encryptor{key: key}, nil
}

func (e *encryptor) encrypt(plaintext []byte) ([]byte, error) {
	block, err := aes.NewCipher(e.key)
	if err != nil {
		return nil, err
	}
	gcm, err := cipher.NewGCM(block)
	if err != nil {
		return nil, err
	}
	nonce := make([]byte, gcm.NonceSize())
	if _, err := rand.Read(nonce); err != nil {
		return nil, err
	}
	return gcm.Seal(nonce, nonce, plaintext, nil), nil
}

func (e *encryptor) decrypt(ciphertext []byte) ([]byte, error) {
	block, err := aes.NewCipher(e.key)
	if err != nil {
		return nil, err
	}
	gcm, err := cipher.NewGCM(block)
	if err != nil {
		return nil, err
	}
	if len(ciphertext) < gcm.NonceSize() {
		return nil, errors.New("ciphertext too short")
	}
	nonce, ct := ciphertext[:gcm.NonceSize()], ciphertext[gcm.NonceSize():]
	return gcm.Open(nil, nonce, ct, nil)
}

// --- Token/ID generation ---
// Access and refresh tokens are only ever stored as a sha256 hash; the plaintext
// is handed to the caller once and never persisted.

func generateRandomToken() (string, error) {
	buf := make([]byte, 32)
	if _, err := rand.Read(buf); err != nil {
		return "", err
	}
	return hex.EncodeToString(buf), nil
}

func hashToken(token string) string {
	sum := sha256.Sum256([]byte(token))
	return hex.EncodeToString(sum[:])
}

func generateTokenPair() (plain, hash string, err error) {
	plain, err = generateRandomToken()
	if err != nil {
		return "", "", err
	}
	return plain, hashToken(plain), nil
}

func newID() string {
	buf := make([]byte, 16)
	if _, err := rand.Read(buf); err != nil {
		return fmt.Sprintf("id-%d", time.Now().UnixNano())
	}
	return hex.EncodeToString(buf)
}
