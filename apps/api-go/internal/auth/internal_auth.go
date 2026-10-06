package auth

import (
	"bytes"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"io"
	"net/http"
	"strconv"
	"time"
)

const internalRequestMaxAge = 5 * time.Minute

// internalOnly authenticates a two-runtime service request. The service signs
// the exact request body, method, path and a short-lived timestamp with the
// deployment's shared secret. This keeps the internal endpoint closed even on
// a flat local/compose network; mTLS can be added at the deployment edge.
func (h *Handler) internalOnly(expectedService string, next http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if !h.validInternalRequest(r, expectedService, time.Now().UTC()) {
			writeErr(w, ErrUnauthorized)
			return
		}
		next(w, r)
	}
}

func (h *Handler) validInternalRequest(r *http.Request, expectedService string, now time.Time) bool {
	if len(h.internalSharedSecret) == 0 || r.Header.Get("X-DD-Service") != expectedService {
		return false
	}

	timestamp := r.Header.Get("X-DD-Timestamp")
	seconds, err := strconv.ParseInt(timestamp, 10, 64)
	if err != nil {
		return false
	}
	issuedAt := time.Unix(seconds, 0)
	if issuedAt.Before(now.Add(-internalRequestMaxAge)) || issuedAt.After(now.Add(internalRequestMaxAge)) {
		return false
	}

	body, err := io.ReadAll(r.Body)
	if err != nil {
		return false
	}
	r.Body = io.NopCloser(bytes.NewReader(body))
	bodyHash := sha256.Sum256(body)
	payload := r.Method + "\n" + r.URL.Path + "\n" + timestamp + "\n" + hex.EncodeToString(bodyHash[:])
	mac := hmac.New(sha256.New, h.internalSharedSecret)
	_, _ = mac.Write([]byte(payload))
	expected, err := hex.DecodeString(r.Header.Get("X-DD-Signature"))
	return err == nil && hmac.Equal(mac.Sum(nil), expected)
}
