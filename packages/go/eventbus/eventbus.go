// Package eventbus is a thin wrapper around NATS JetStream (ADR-023, which
// supersedes ADR-016's Kafka/Redpanda choice -- see
// .spec/technical/adr/adr-023.md) giving Go services the same
// publish/durable-consume shape every ARCH-005 named queue needs: a
// producer that gets a persistence ack, and a consumer that processes
// messages one at a time, in order, acking only after successful handling
// so a crash mid-process redelivers rather than drops (at-least-once).
//
// This package deliberately does not hide JetStream behind a
// fully-generic interface -- callers still choose their own stream/subject
// names and consumer durability, since those are queue-specific decisions
// (see ARCH-005's ~20 named queues). What it standardizes is connection
// setup, stream/consumer idempotent provisioning, and the publish/consume
// call shape, so every Go service wires a queue the same way.
package eventbus

import (
	"context"
	"encoding/json"
	"fmt"
	"time"

	"github.com/nats-io/nats.go"
	"github.com/nats-io/nats.go/jetstream"
)

// Bus holds a live NATS connection and JetStream context.
type Bus struct {
	nc *nats.Conn
	js jetstream.JetStream
}

// Connect dials the NATS server at url (e.g. "nats://localhost:4222").
func Connect(url string) (*Bus, error) {
	nc, err := nats.Connect(url, nats.Name("digital-democracy"), nats.MaxReconnects(-1))
	if err != nil {
		return nil, fmt.Errorf("eventbus: connect: %w", err)
	}
	js, err := jetstream.New(nc)
	if err != nil {
		nc.Close()
		return nil, fmt.Errorf("eventbus: jetstream: %w", err)
	}
	return &Bus{nc: nc, js: js}, nil
}

// Close drains and closes the underlying connection.
func (b *Bus) Close() {
	_ = b.nc.Drain()
}

// StreamConfig describes the stream a publisher or consumer needs to exist.
// Provisioning is idempotent: EnsureStream creates it if missing, and
// leaves an existing stream with matching subjects alone.
type StreamConfig struct {
	// Name is the JetStream stream name (upper-snake by convention, e.g. "AUDIT").
	Name string
	// Subjects this stream captures, e.g. []string{"audit.append"}.
	Subjects []string
}

// EnsureStream idempotently provisions the stream so either a publisher or
// a consumer can call it at startup without ordering assumptions about
// which service boots first.
func EnsureStream(ctx context.Context, b *Bus, cfg StreamConfig) error {
	_, err := b.js.CreateOrUpdateStream(ctx, jetstream.StreamConfig{
		Name:     cfg.Name,
		Subjects: cfg.Subjects,
		// Audit-grade queues (ADR-016: "infinite retention... never
		// deleted") get this via WorkQueue-incompatible, Limits-based
		// retention with no MaxAge/MaxMsgs set by the caller; callers
		// needing bounded retention set those in a future extension of
		// StreamConfig -- not needed by any queue this codebase has
		// wired up yet.
		Retention: jetstream.LimitsPolicy,
		Storage:   jetstream.FileStorage,
	})
	if err != nil {
		return fmt.Errorf("eventbus: ensure stream %s: %w", cfg.Name, err)
	}
	return nil
}

// Publish marshals payload as JSON and publishes it to subject, waiting for
// JetStream's persistence ack before returning -- the "did this actually
// get durably queued" guarantee a fire-and-forget nc.Publish can't give.
func Publish(ctx context.Context, b *Bus, subject string, payload any) error {
	data, err := json.Marshal(payload)
	if err != nil {
		return fmt.Errorf("eventbus: marshal payload for %s: %w", subject, err)
	}
	if _, err := b.js.Publish(ctx, subject, data); err != nil {
		return fmt.Errorf("eventbus: publish %s: %w", subject, err)
	}
	return nil
}

// ConsumerConfig describes a durable, ordered consumer.
type ConsumerConfig struct {
	// Stream is the StreamConfig.Name this consumer binds to.
	Stream string
	// Durable is the consumer's durable name -- reconnecting with the same
	// name resumes from where it left off rather than replaying or
	// skipping (ARCH-005: "exactly one consumer" per queue like
	// audit.append maps to exactly one durable name).
	Durable string
	// FilterSubject narrows delivery to one subject within the stream, if
	// the stream captures more than one.
	FilterSubject string
}

// Handler processes one message. Returning nil acks it (processed,
// remove from the redelivery queue); returning an error naks it (NATS
// will redeliver later) -- this is what makes the queue at-least-once
// rather than at-most-once.
type Handler func(ctx context.Context, data []byte) error

// Consume idempotently provisions the durable consumer described by cfg,
// then processes messages one at a time (MaxAckPending(1)), in delivery
// order, until ctx is cancelled. A handler error naks the message (redelivered,
// per DP-036's ordering requirement this must not just skip ahead) rather
// than being silently dropped or crashing the process.
func Consume(ctx context.Context, b *Bus, cfg ConsumerConfig, handle Handler) error {
	consumerCfg := jetstream.ConsumerConfig{
		Durable:       cfg.Durable,
		AckPolicy:     jetstream.AckExplicitPolicy,
		MaxAckPending: 1,
	}
	if cfg.FilterSubject != "" {
		consumerCfg.FilterSubject = cfg.FilterSubject
	}
	consumer, err := b.js.CreateOrUpdateConsumer(ctx, cfg.Stream, consumerCfg)
	if err != nil {
		return fmt.Errorf("eventbus: ensure consumer %s/%s: %w", cfg.Stream, cfg.Durable, err)
	}

	consumeCtx, err := consumer.Consume(func(msg jetstream.Msg) {
		handleCtx, cancel := context.WithTimeout(ctx, 30*time.Second)
		defer cancel()
		if err := handle(handleCtx, msg.Data()); err != nil {
			_ = msg.Nak()
			return
		}
		_ = msg.Ack()
	})
	if err != nil {
		return fmt.Errorf("eventbus: start consuming %s/%s: %w", cfg.Stream, cfg.Durable, err)
	}

	<-ctx.Done()
	consumeCtx.Stop()
	return nil
}
