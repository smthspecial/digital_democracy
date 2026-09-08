package voting

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"time"

	"github.com/digital-democracy/eventbus"
)

// httpDelegationResolver is the production DelegationResolver: it calls
// delegation-service over HTTP (ARCH-009: the no-op seam becomes a real
// HTTP-calling implementation of the same interface). Failures degrade to
// "no delegations" so a delegation-service outage can never lose a vote;
// tally-time reconciliation covers the gap.
type httpDelegationResolver struct {
	base   string
	client *http.Client
}

func NewHTTPDelegationResolver(base string) *httpDelegationResolver {
	return &httpDelegationResolver{base: base, client: &http.Client{Timeout: 3 * time.Second}}
}

func (h *httpDelegationResolver) DelegatorsFor(sessionID, citizenID string) ([]string, error) {
	req, err := http.NewRequest(http.MethodGet,
		fmt.Sprintf("%s/delegation/resolve?session_id=%s&citizen_id=%s", h.base, sessionID, citizenID), nil)
	if err != nil {
		return nil, nil
	}
	resp, err := h.client.Do(req)
	if err != nil {
		return nil, nil
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return nil, nil
	}
	var out struct {
		Delegators []string `json:"delegators"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&out); err != nil {
		return nil, nil
	}
	return out.Delegators, nil
}

// natsAuditEmitter publishes lifecycle events to the audit.append JetStream
// stream (DP-036 over ADR-023). Publish is synchronous with server ack, so a
// returned nil means durable storage; the event id is the JetStream dedupe
// key AND the consumer-side idempotency key (at-least-once, ADR-023).
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

// httpAuditEmitter POSTs lifecycle events to audit-service (DP-036).
// Delivery is fire-and-forget: audit backfill runs off the service's own
// state transitions, so a failed emission never fails the vote itself.
type httpAuditEmitter struct {
	base   string
	client *http.Client
}

func NewHTTPAuditEmitter(base string) *httpAuditEmitter {
	return &httpAuditEmitter{base: base, client: &http.Client{Timeout: 3 * time.Second}}
}

func (h *httpAuditEmitter) Emit(actionType, actorRef, payload string) error {
	body, _ := json.Marshal(map[string]string{
		"action_type": actionType,
		"actor_ref":   actorRef,
		"payload":     payload,
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
