package voting

import (
	"bytes"
	"io"
	"net/http"
	"net/url"
	"time"

	"github.com/digital-democracy/api-go/internal/security"
)

type HTTPCertificationSink struct {
	base, secret string
	client       *http.Client
}

func NewHTTPCertificationSink(base, secret string) *HTTPCertificationSink {
	return &HTTPCertificationSink{base, secret, &http.Client{Timeout: 5 * time.Second}}
}

func (s *HTTPCertificationSink) Completed(sessionID string) error {
	if s.base == "" || s.secret == "" {
		return ErrGovernanceUnavailable
	}
	body := []byte("{}")
	req, err := http.NewRequest(http.MethodPost, s.base+"/journey/sessions/"+url.PathEscape(sessionID)+"/reconcile", bytes.NewReader(body))
	if err != nil {
		return ErrGovernanceUnavailable
	}
	req.Header.Set("Content-Type", "application/json")
	security.Sign(req, "api-go", s.secret, body)
	response, err := s.client.Do(req)
	if err != nil {
		return ErrGovernanceUnavailable
	}
	defer response.Body.Close()
	_, _ = io.CopyN(io.Discard, response.Body, 4096)
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		return ErrGovernanceUnavailable
	}
	return nil
}
