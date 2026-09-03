package main

import (
	"context"

	"github.com/digital-democracy/packages/go/eventbus"
)

const (
	auditStreamName    = "AUDIT"
	auditAppendSubject = "audit.append"
)

// natsAuditEmitter publishes to the real audit.append queue (ADR-023)
// instead of calling audit-service's HTTP endpoint directly (httpAuditEmitter,
// remote.go). vote_certified is already the exact TBL-034 action_type this
// service's only Emit call site (service.go) passes, so no local-to-TBL-034
// mapping is needed here, unlike some other services' NATS audit emitters.
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

func (e *natsAuditEmitter) Emit(eventType, payload string) error {
	ctx, cancel := context.WithTimeout(context.Background(), remoteCallTimeout)
	defer cancel()
	return eventbus.Publish(ctx, e.bus, auditAppendSubject, map[string]any{
		"action_type":     eventType,
		"actor_ref":       "voting-service",
		"payload":         payload,
		"idempotency_key": eventType + ":" + payload,
	})
}
