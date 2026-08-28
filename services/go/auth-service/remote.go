// Real HTTP-calling implementation of IdentityChecker, used in place of the
// fail-closed no-op default when IDENTITY_SERVICE_URL is configured (see
// main.go).
package main

import (
	"encoding/json"
	"fmt"
	"net/http"
	"net/url"
	"time"
)

const remoteCallTimeout = 3 * time.Second

// httpIdentityChecker calls identity-service's real citizen lookup
// (SRV-001, GET /identity/citizens/:id).
type httpIdentityChecker struct {
	baseURL string
	client  *http.Client
}

func newHTTPIdentityChecker(baseURL string) *httpIdentityChecker {
	return &httpIdentityChecker{baseURL: baseURL, client: &http.Client{Timeout: remoteCallTimeout}}
}

func (c *httpIdentityChecker) CitizenStatus(citizenID string) (string, error) {
	resp, err := c.client.Get(c.baseURL + "/identity/citizens/" + url.PathEscape(citizenID))
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return "", fmt.Errorf("identity-service citizen lookup returned status %d", resp.StatusCode)
	}

	var decoded struct {
		Status string `json:"status"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&decoded); err != nil {
		return "", err
	}
	return decoded.Status, nil
}
