package main

import (
	"context"
	"encoding/json"
	"log/slog"

	"github.com/digital-democracy/packages/go/eventbus"
)

const (
	auditStreamName    = "AUDIT"
	auditAppendSubject = "audit.append"
	auditConsumerName  = "audit-service-append"
)

// auditAppendMessage mirrors appendLogRequest (handlers.go) -- publishers
// send the exact same shape whether they call POST /audit/log directly or
// publish to the audit.append queue (ADR-023); this consumer is just
// another entry point into the same Service.Append.
type auditAppendMessage struct {
	ActionType     string `json:"action_type"`
	ActorRef       string `json:"actor_ref"`
	Payload        any    `json:"payload"`
	IdempotencyKey string `json:"idempotency_key"`
}

// startAuditAppendConsumer subscribes to the audit.append queue (DP-036) and
// appends each message to the hash chain via the same Service.Append POST
// /audit/log uses, so publishers no longer need a live synchronous HTTP
// round trip just to get an event durably queued (ADR-023). Runs until ctx
// is cancelled; errors connecting or provisioning the stream are returned
// to the caller so a misconfigured NATS_URL fails startup loudly rather
// than silently running with no consumer.
func startAuditAppendConsumer(ctx context.Context, logger *slog.Logger, natsURL string, svc *Service) error {
	bus, err := eventbus.Connect(natsURL)
	if err != nil {
		return err
	}

	if err := eventbus.EnsureStream(ctx, bus, eventbus.StreamConfig{
		Name:     auditStreamName,
		Subjects: []string{auditAppendSubject},
	}); err != nil {
		bus.Close()
		return err
	}

	go func() {
		defer bus.Close()
		err := eventbus.Consume(ctx, bus, eventbus.ConsumerConfig{
			Stream:        auditStreamName,
			Durable:       auditConsumerName,
			FilterSubject: auditAppendSubject,
		}, func(_ context.Context, data []byte) error {
			var msg auditAppendMessage
			if err := json.Unmarshal(data, &msg); err != nil {
				// Malformed messages can never succeed on redelivery -- nak'ing
				// would redeliver forever with no dead-letter queue behind this
				// consumer. Log and ack (drop) rather than poison the stream.
				logger.Error("audit.append: malformed message, dropping", "error", err)
				return nil
			}
			if _, err := svc.Append(ActionType(msg.ActionType), msg.ActorRef, msg.Payload, msg.IdempotencyKey); err != nil {
				// Same reasoning: Service.Append's error modes (invalid
				// action_type, missing actor_ref) are validation failures on
				// the message content itself, not transient infra failures --
				// redelivery cannot fix them either.
				logger.Error("audit.append: rejected by Service.Append, dropping", "error", err)
				return nil
			}
			return nil
		})
		if err != nil {
			logger.Error("audit.append consumer stopped", "error", err)
		}
	}()

	return nil
}
