package voting

import (
	"bytes"
	"encoding/json"
	"fmt"
	"github.com/digital-democracy/api-go/internal/security"
	"io"
	"net/http"
	"net/url"
	"time"
)

type EligibilitySource interface {
	EligibleCitizens(proposal, jurisdiction, after string) ([]string, string, error)
}
type httpEligibilitySource struct {
	base, secret string
	client       *http.Client
}

func NewHTTPEligibilitySource(base, secret string) EligibilitySource {
	return &httpEligibilitySource{base, secret, &http.Client{Timeout: 3 * time.Second}}
}
func (s *httpEligibilitySource) EligibleCitizens(proposal, jurisdiction, after string) ([]string, string, error) {
	if s.base == "" || s.secret == "" {
		return nil, "", ErrInvalidState
	}
	path := "/jurisdiction/proposals/" + url.PathEscape(proposal) + "/jurisdictions/" + url.PathEscape(jurisdiction) + "/eligible-citizens"
	if after != "" {
		path += "?after=" + url.QueryEscape(after)
	}
	req, err := http.NewRequest("GET", s.base+path, nil)
	if err != nil {
		return nil, "", err
	}
	security.Sign(req, "api-go", s.secret, nil)
	resp, err := s.client.Do(req)
	if err != nil {
		return nil, "", err
	}
	defer resp.Body.Close()
	if resp.StatusCode != 200 {
		return nil, "", fmt.Errorf("eligibility source rejected request")
	}
	var result struct {
		CitizenIDs []string `json:"citizen_ids"`
		Next       string   `json:"next_cursor"`
	}
	if err := json.NewDecoder(io.LimitReader(resp.Body, 64<<10)).Decode(&result); err != nil {
		return nil, "", err
	}
	if len(result.CitizenIDs) > 500 {
		return nil, "", ErrInvalid
	}
	return result.CitizenIDs, result.Next, nil
}

// Ciphertext validation belongs to the cryptographic election component. Never
// accept arbitrary strings while that proof verifier is absent. It receives no
// citizen identity or eligibility token, maintaining the secrecy boundary.
type BallotProofVerifier interface {
	Verify(session, ciphertext, proof string) bool
}
type httpBallotVerifier struct{ base, secret string }

func NewHTTPBallotVerifier(base, secret string) BallotProofVerifier {
	return &httpBallotVerifier{base, secret}
}
func (v *httpBallotVerifier) Verify(session, ciphertext, proof string) bool {
	if v.base == "" || v.secret == "" || proof == "" {
		return false
	}
	body, _ := json.Marshal(map[string]string{"vote_session_id": session, "encrypted_choice": ciphertext, "proof": proof})
	req, err := http.NewRequest("POST", v.base+"/ballots/verify", bytes.NewReader(body))
	if err != nil {
		return false
	}
	req.Header.Set("Content-Type", "application/json")
	security.Sign(req, "api-go", v.secret, body)
	resp, err := (&http.Client{Timeout: 3 * time.Second}).Do(req)
	if err != nil {
		return false
	}
	defer resp.Body.Close()
	var result struct {
		Valid bool `json:"valid"`
	}
	return resp.StatusCode == 200 && json.NewDecoder(io.LimitReader(resp.Body, 4096)).Decode(&result) == nil && result.Valid
}
