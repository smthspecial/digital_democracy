package delegation

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"time"

	"github.com/digital-democracy/eventbus"
)

// httpCompetencyChecker calls competency-service:
// GET /competency/citizens/:citizenId/domains/:domainId → {active: bool}.
// Any transport error or non-200 fails closed (no delegation without proof).
type httpCompetencyChecker struct {
	base   string
	client *http.Client
}

func NewHTTPCompetencyChecker(base string) *httpCompetencyChecker {
	return &httpCompetencyChecker{base: base, client: &http.Client{Timeout: 3 * time.Second}}
}

func (c *httpCompetencyChecker) HasActiveCompetency(citizenID, domainID string) (bool, error) {
	resp, err := c.client.Get(fmt.Sprintf("%s/competency/citizens/%s/domains/%s", c.base, citizenID, domainID))
	if err != nil {
		return false, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return false, fmt.Errorf("competency-service returned %d", resp.StatusCode)
	}
	var out struct {
		Active bool `json:"active"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&out); err != nil {
		return false, err
	}
	return out.Active, nil
}

// natsAuditEmitter publishes to audit.append (DP-036 over ADR-023).
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
