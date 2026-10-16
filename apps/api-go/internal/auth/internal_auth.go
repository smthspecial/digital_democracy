package auth

import (
	"github.com/digital-democracy/api-go/internal/security"
	"net/http"
	"time"
)

const internalRequestMaxAge = 5 * time.Minute

func (h *Handler) internalOnly(expectedService string, next http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if security.Verify(w, r, expectedService, string(h.internalSharedSecret), h.replays) {
			next(w, r)
		}
	}
}
