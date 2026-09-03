package main

import (
	"context"
	"time"

	"github.com/digital-democracy/packages/go/eventbus"
)

const (
	auditStreamName    = "AUDIT"
	auditAppendSubject = "audit.append"
	remoteCallTimeout  = 3 * time.Second
)

// natsAuditEmitter publishes to the real audit.append queue (ADR-023).
// delegation.created/revoked/expired have no dedicated TBL-034 action_type
// of their own -- these are citizen-initiated actions over their own voting
// power, not an admin/governance action, so they map to the generic
// system_update bucket, same fallback used by
// problem-service/project-service/reputation-service/deliberation-service/
// ai-synthesis-service for events without a dedicated bucket.
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
// (service.go's call sites don't check an error return) -- a downed
// NATS/audit-service must never block the delegation flow that triggered
// it, so publish failures are only discarded, not surfaced.
func (e *natsAuditEmitter) Emit(event string, d *Delegation) {
	ctx, cancel := context.WithTimeout(context.Background(), remoteCallTimeout)
	defer cancel()
	_ = eventbus.Publish(ctx, e.bus, auditAppendSubject, map[string]any{
		"action_type": "system_update",
		"actor_ref":   "delegation-service",
		"payload": map[string]any{
			"event":        event,
			"id":           d.ID,
			"delegator_id": d.DelegatorID,
			"delegate_id":  d.DelegateID,
			"domain_id":    d.DomainID,
			"created_at":   d.CreatedAt,
			"expires_at":   d.ExpiresAt,
			"revoked_at":   d.RevokedAt,
		},
		"idempotency_key": event + ":" + d.ID,
	})
}
