// Package security implements the shared HTTP trust boundary for api-go.
package security

import (
	"bytes"
	"context"
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"io"
	"net"
	"net/http"
	"strconv"
	"sync"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
)

const MaxBody = 64 << 10

type contextKey string

const citizenKey contextKey = "citizen"
const serviceKey contextKey = "service"

func CitizenID(r *http.Request) string { v, _ := r.Context().Value(citizenKey).(string); return v }
func ServiceID(r *http.Request) string { v, _ := r.Context().Value(serviceKey).(string); return v }

func Error(w http.ResponseWriter, status int, code string) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(map[string]any{"error": map[string]string{"code": code, "message": http.StatusText(status)}})
}

// ReplayStore retains accepted signatures until their complete validity window
// ends. Postgres uniqueness makes consumption atomic across replicas/restarts.
type ReplayStore struct {
	Pool *pgxpool.Pool
	mu   sync.Mutex
	seen map[string]time.Time
}

func (s *ReplayStore) Claim(ctx context.Context, key string, expires time.Time) bool {
	if s.Pool != nil {
		ctx, cancel := context.WithTimeout(ctx, 3*time.Second)
		defer cancel()
		_, err := s.Pool.Exec(ctx, "DELETE FROM security_request WHERE expires_at < now()")
		if err != nil {
			return false
		}
		result, err := s.Pool.Exec(ctx, "INSERT INTO security_request (signature_hash,expires_at) VALUES ($1,$2) ON CONFLICT DO NOTHING", key, expires)
		return err == nil && result.RowsAffected() == 1
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.seen == nil {
		s.seen = map[string]time.Time{}
	}
	for key, expiry := range s.seen {
		if expiry.Before(time.Now()) {
			delete(s.seen, key)
		}
	}
	if _, ok := s.seen[key]; ok || len(s.seen) >= 10000 {
		return false
	}
	s.seen[key] = expires
	return true
}

func signature(secret, service, method, target, timestamp, nonce string, body []byte) []byte {
	sum := sha256.Sum256(body)
	payload := service + "\n" + method + "\n" + target + "\n" + timestamp + "\n" + nonce + "\n" + hex.EncodeToString(sum[:])
	mac := hmac.New(sha256.New, []byte(secret))
	_, _ = mac.Write([]byte(payload))
	return mac.Sum(nil)
}

func Sign(req *http.Request, service, secret string, body []byte) {
	timestamp := strconv.FormatInt(time.Now().Unix(), 10)
	random := make([]byte, 16)
	if _, err := rand.Read(random); err != nil {
		panic(err)
	}
	nonce := hex.EncodeToString(random)
	req.Header.Set("X-DD-Service", service)
	req.Header.Set("X-DD-Timestamp", timestamp)
	req.Header.Set("X-DD-Nonce", nonce)
	req.Header.Set("X-DD-Signature", hex.EncodeToString(signature(secret, service, req.Method, req.URL.RequestURI(), timestamp, nonce, body)))
}

// Verify never reads an unbounded unauthenticated body, and never trusts actor
// headers. Query parameters, when present, are signed as part of the target.
func Verify(w http.ResponseWriter, r *http.Request, service, secret string, replays *ReplayStore) bool {
	timestamp := r.Header.Get("X-DD-Timestamp")
	seconds, err := strconv.ParseInt(timestamp, 10, 64)
	now := time.Now()
	issued := time.Unix(seconds, 0)
	if err != nil || secret == "" || len(r.Header.Get("X-DD-Nonce")) != 32 || r.Header.Get("X-DD-Service") != service || issued.Before(now.Add(-5*time.Minute)) || issued.After(now.Add(5*time.Minute)) {
		Error(w, 401, "unauthorized")
		return false
	}
	body, err := io.ReadAll(http.MaxBytesReader(w, r.Body, MaxBody))
	if err != nil {
		Error(w, 413, "payload_too_large")
		return false
	}
	r.Body = io.NopCloser(bytes.NewReader(body))
	received, err := hex.DecodeString(r.Header.Get("X-DD-Signature"))
	wanted := signature(secret, service, r.Method, r.URL.RequestURI(), timestamp, r.Header.Get("X-DD-Nonce"), body)
	if err != nil || !hmac.Equal(received, wanted) {
		Error(w, 401, "unauthorized")
		return false
	}
	digest := sha256.Sum256(received)
	if replays == nil || !replays.Claim(r.Context(), service+":"+hex.EncodeToString(digest[:]), issued.Add(5*time.Minute)) {
		Error(w, 401, "request_replayed")
		return false
	}
	*r = *r.WithContext(context.WithValue(r.Context(), serviceKey, service))
	return true
}

type Access struct {
	Secret   string
	Replays  *ReplayStore
	Validate func(token string) (citizen, tier string, err error)
}

func (a *Access) Internal(service string, next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if Verify(w, r, service, a.Secret, a.Replays) {
			next.ServeHTTP(w, r)
		}
	})
}
func (a *Access) InternalEither(services []string, next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		for _, service := range services {
			if r.Header.Get("X-DD-Service") == service {
				a.Internal(service, next).ServeHTTP(w, r)
				return
			}
		}
		Error(w, 401, "unauthorized")
	})
}
func (a *Access) Citizen(minimum string, next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		authorization := r.Header.Get("Authorization")
		if len(authorization) <= 7 || authorization[:7] != "Bearer " || a.Validate == nil {
			Error(w, 401, "unauthorized")
			return
		}
		citizen, tier, err := a.Validate(authorization[7:])
		if err != nil || citizen == "" {
			Error(w, 401, "unauthorized")
			return
		}
		if tier != "T1" && tier != "T2" && tier != "T3" || tier < minimum {
			Error(w, 403, "step_up_required")
			return
		}
		r = r.WithContext(context.WithValue(r.Context(), citizenKey, citizen))
		next.ServeHTTP(w, r)
	})
}

// Limit is a bounded process-local backstop. Proxy-supplied headers are ignored;
// deployments also apply per-citizen/distributed limits at their trusted edge.
func Limit(next http.Handler) http.Handler {
	type window struct {
		count int
		end   time.Time
	}
	var mu sync.Mutex
	windows := map[string]window{}
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		host, _, err := net.SplitHostPort(r.RemoteAddr)
		if err != nil {
			host = r.RemoteAddr
		}
		now := time.Now()
		mu.Lock()
		for key, value := range windows {
			if value.end.Before(now) {
				delete(windows, key)
			}
		}
		value := windows[host]
		if value.end.IsZero() {
			value.end = now.Add(time.Minute)
		}
		blocked := value.count >= 120 || len(windows) >= 10000 && value.count == 0
		value.count++
		if !blocked {
			windows[host] = value
		}
		mu.Unlock()
		if blocked {
			w.Header().Set("Retry-After", "60")
			Error(w, 429, "rate_limited")
			return
		}
		r.Body = http.MaxBytesReader(w, r.Body, MaxBody)
		next.ServeHTTP(w, r)
	})
}
