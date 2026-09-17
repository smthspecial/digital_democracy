package auth

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"time"

	"github.com/digital-democracy/eventbus"
)

// httpIdentityChecker reads citizen.status from identity-service:
// GET /identity/citizens/:id/status → {status}. Transport errors and
// non-200 fail closed (no session without proof of an active identity).
//
// BUG-002 (fixed here): this used to GET /identity/citizens/:id -- the
// identity:read:own route, gated by identity-service's own requester-equals-
// citizen check (identity.controller.ts's getById -> getOwn). A
// service-to-service caller authenticating a citizen who has no session
// yet can never satisfy that check, so every login 401ed with the old
// path regardless of the real citizen.status. The status-only route
// (identity.controller.ts's statusOf) is worker-scoped and carries no such
// check by design -- it also leaks strictly less (status only, no
// publicHandle/legalIdentityHash) than the old route did.
type httpIdentityChecker struct {
	base   string
	client *http.Client
}

func NewHTTPIdentityChecker(base string) *httpIdentityChecker {
	return &httpIdentityChecker{base: base, client: &http.Client{Timeout: 3 * time.Second}}
}

func (c *httpIdentityChecker) StatusOf(citizenID string) (string, error) {
	resp, err := c.client.Get(fmt.Sprintf("%s/identity/citizens/%s/status", c.base, citizenID))
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return "", fmt.Errorf("identity-service returned %d", resp.StatusCode)
	}
	var out struct {
		Status string `json:"status"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&out); err != nil {
		return "", err
	}
	return out.Status, nil
}

// natsAuditEmitter publishes identity_event entries to audit.append
// (DP-036 over ADR-023, publish-with-ack + message-id dedupe).
type natsAuditEmitter struct {
	bus *eventbus.Bus
}

// NewNATSAuditEmitter shares the process-wide NATS connection: one app,
// one connection (the bus is safe for concurrent use). The audit.append
// stream is ensured once at boot by main.
func NewNATSAuditEmitter(bus *eventbus.Bus) *natsAuditEmitter {
	return &natsAuditEmitter{bus: bus}
}

func (e *natsAuditEmitter) Emit(actionType, actorRef, payload string) error {
	evt := eventbus.AuditEvent{
		ID:         eventbus.NewAuditEventID(),
		ActionType: actionType,
		ActorRef:   actorRef,
		Payload:    payload,
		OccurredAt: time.Now().UTC(),
	}
	body, _ := json.Marshal(evt)
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	return e.bus.Publish(ctx, eventbus.QueueAuditAppend, body, eventbus.WithMessageID(evt.ID))
}

// httpAuditEmitter POSTs to audit-service; fire-and-forget.
type httpAuditEmitter struct {
	base   string
	client *http.Client
}

func NewHTTPAuditEmitter(base string) *httpAuditEmitter {
	return &httpAuditEmitter{base: base, client: &http.Client{Timeout: 3 * time.Second}}
}

func (h *httpAuditEmitter) Emit(actionType, actorRef, payload string) error {
	body, _ := json.Marshal(map[string]string{
		"action_type": actionType, "actor_ref": actorRef, "payload": payload,
	})
	resp, err := h.client.Post(h.base+"/audit/log", "application/json", bytes.NewReader(body))
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode >= 300 {
		return fmt.Errorf("audit-service returned %d", resp.StatusCode)
	}
	return nil
}

// httpNotifier POSTs to notification-service (DP-039, best-effort).
type httpNotifier struct {
	base   string
	client *http.Client
}

func NewHTTPNotifier(base string) *httpNotifier {
	return &httpNotifier{base: base, client: &http.Client{Timeout: 3 * time.Second}}
}

func (n *httpNotifier) Notify(kind, recipientRef, message string) error {
	body, _ := json.Marshal(map[string]string{
		"kind": kind, "recipient_ref": recipientRef, "message": message,
	})
	resp, err := n.client.Post(n.base+"/notifications/dispatch", "application/json", bytes.NewReader(body))
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode >= 300 {
		return fmt.Errorf("notification-service returned %d", resp.StatusCode)
	}
	return nil
}
