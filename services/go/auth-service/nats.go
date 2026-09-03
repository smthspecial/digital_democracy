package main

import (
	"context"

	"github.com/digital-democracy/packages/go/eventbus"
)

const (
	auditStreamName    = "AUDIT"
	auditAppendSubject = "audit.append"
)

// natsAuditEmitter publishes to the real audit.append queue (ADR-023).
// AuthEvent has no dedicated TBL-034 action_type of its own (unlike
// identity-service's identity_event or voting-service's vote_certified), so
// every event this service emits (login, MFA, step-up, anomaly, session,
// factor lifecycle) maps to the generic system_update bucket, same fallback
// used by problem-service/project-service/reputation-service/
// deliberation-service/ai-synthesis-service for events without a dedicated
// bucket. e.ID is already a unique, store-assigned identifier by the time
// Emit is called (store.AppendEvent runs first in recordEvent), so it
// doubles as the idempotency key with no extra generation needed.
type natsAuditEmitter struct {
	bus *eventbus.Bus
}

// newNATSAuditEmitter connects and idempotently provisions the AUDIT stream
// once at startup, so the returned emitter's Emit calls are just a publish.
func newNATSAuditEmitter(ctx context.Context, natsURL string) (*natsAuditEmitter, error) {
	bus, err := eventbus.Connect(natsURL)
	if err != nil {
		return nil, err
	}
	if err := eventbus.EnsureStream(ctx, bus, eventbus.StreamConfig{
		Name:     auditStreamName,
		Subjects: []string{auditAppendSubject},
	}); err != nil {
		bus.Close()
		return nil, err
	}
	return &natsAuditEmitter{bus: bus}, nil
}

// Emit implements AuditEmitter. Fire-and-forget per the interface contract
// (service.go's recordEvent does not check an error return) -- a downed
// NATS/audit-service must never block the auth flow that triggered it, so
// publish failures are only logged, not surfaced.
func (e *natsAuditEmitter) Emit(event AuthEvent) {
	ctx, cancel := context.WithTimeout(context.Background(), remoteCallTimeout)
	defer cancel()
	_ = eventbus.Publish(ctx, e.bus, auditAppendSubject, map[string]any{
		"action_type": "system_update",
		"actor_ref":   "auth-service",
		"payload": map[string]any{
			"id":                 event.ID,
			"citizen_id":         event.CitizenID,
			"session_id":         event.SessionID,
			"event_type":         event.EventType,
			"factor_type":        event.FactorType,
			"ip_address":         event.IPAddress,
			"device_fingerprint": event.DeviceFingerprint,
			"anomaly_reason":     event.AnomalyReason,
			"created_at":         event.CreatedAt,
		},
		"idempotency_key": event.ID,
	})
}
