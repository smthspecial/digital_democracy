// Real HTTP-calling implementations of DelegationResolver and AuditEmitter,
// used in place of the no-op defaults when DELEGATION_SERVICE_URL /
// AUDIT_SERVICE_URL are configured (see main.go). Both fail soft: neither
// blocks or reverses the ballot cast / session certification that
// triggered them, consistent with how their call sites already treat them
// as fire-and-forget.
package main

import (
	"bytes"
	"encoding/json"
	"fmt"
	"net/http"
	"time"
)

const remoteCallTimeout = 3 * time.Second

// httpDelegationResolver calls delegation-service's DP-041 chain-resolution
// endpoint (SRV-010, POST /delegation/resolve).
type httpDelegationResolver struct {
	baseURL string
	client  *http.Client
}

func newHTTPDelegationResolver(baseURL string) *httpDelegationResolver {
	return &httpDelegationResolver{baseURL: baseURL, client: &http.Client{Timeout: remoteCallTimeout}}
}

func (r *httpDelegationResolver) ResolveDelegators(citizenID, domainID string) ([]string, error) {
	body, err := json.Marshal(map[string]string{"delegate_id": citizenID, "domain_id": domainID})
	if err != nil {
		return nil, err
	}
	req, err := http.NewRequest(http.MethodPost, r.baseURL+"/delegation/resolve", bytes.NewReader(body))
	if err != nil {
		return nil, err
	}
	req.Header.Set("Content-Type", "application/json")

	resp, err := r.client.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("delegation-service resolve returned status %d", resp.StatusCode)
	}

	var decoded struct {
		DelegatorIDs []string `json:"delegator_ids"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&decoded); err != nil {
		return nil, err
	}
	return decoded.DelegatorIDs, nil
}

// httpAuditEmitter calls audit-service's DP-036 append endpoint (SRV-012,
// POST /audit/log).
type httpAuditEmitter struct {
	baseURL string
	client  *http.Client
}

func newHTTPAuditEmitter(baseURL string) *httpAuditEmitter {
	return &httpAuditEmitter{baseURL: baseURL, client: &http.Client{Timeout: remoteCallTimeout}}
}

func (e *httpAuditEmitter) Emit(eventType, payload string) error {
	body, err := json.Marshal(map[string]any{
		"action_type":     eventType,
		"actor_ref":       "voting-service",
		"payload":         payload,
		"idempotency_key": eventType + ":" + payload,
	})
	if err != nil {
		return err
	}
	req, err := http.NewRequest(http.MethodPost, e.baseURL+"/audit/log", bytes.NewReader(body))
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/json")

	resp, err := e.client.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusCreated {
		return fmt.Errorf("audit-service append returned status %d", resp.StatusCode)
	}
	return nil
}
