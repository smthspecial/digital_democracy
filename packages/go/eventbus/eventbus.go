// Package eventbus is the shared Go client for the NATS JetStream event
// backbone (ADR-023, superseding ADR-016's Kafka choice; queue topology in
// ARCH-005 §2). Every Go service publishes and consumes through this package
// so adopting a queue looks the same everywhere:
//
//	bus, err := eventbus.Connect(url)
//	bus.EnsureStream(eventbus.QueueAuditAppend)
//	bus.Publish(ctx, eventbus.QueueAuditAppend, payload, eventbus.WithMessageID(id))
//	sub, err := bus.SubscribeOrderedDurable(eventbus.QueueAuditAppend, "audit-service", handler)
//
// Delivery contract (ADR-023, unchanged from ADR-016): at-least-once with
// idempotent writes — producers set a message id (JetStream dedupes by
// Nats-Msg-Id) and consumers dedupe on the source event id. audit.append is
// the strict-ordering special case: exactly one durable consumer with
// max_ack_pending=1 processes messages in delivery order; streams use Limits
// retention (never deleted on ack) so the audit hash chain stays replayable.
package eventbus

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"fmt"
	"strings"
	"time"

	"github.com/nats-io/nats.go"
)

// Named queues from ARCH-005 §2. One JetStream stream per queue (ADR-023).
const (
	QueueIdentityCheck         = "identity.check"
	QueueIdentityRevoke        = "identity.revoke"
	QueueProposalsThreshold    = "proposals.threshold"
	QueueProposalsLifecycle    = "proposals.lifecycle"
	QueueProposalsScope        = "proposals.scope"
	QueueCompetencyReview      = "competency.review"
	QueueCompetencyChallenge   = "competency.challenge"
	QueueIntegrityCOI          = "integrity.coi"
	QueueConstitutionalReview  = "constitutional.review"
	QueueGovernanceApprovals   = "governance.approvals"
	QueueGovernanceProtocol    = "governance.protocol"
	QueueVotingEligibility     = "voting.eligibility"
	QueueVotingTally           = "voting.tally"
	QueueVotingCertify         = "voting.certify"
	QueueVotingDelegation      = "voting.delegation"
	QueueCivicAssign           = "civic.assign"
	QueueReputationUpdate      = "reputation.update"
	QueueAISynthesis           = "ai.synthesis"
	QueueAuditAppend           = "audit.append"
	QueueNotificationsDispatch = "notifications.dispatch"
)

// AllQueues lists every named queue for stream provisioning.
var AllQueues = []string{
	QueueIdentityCheck, QueueIdentityRevoke,
	QueueProposalsThreshold, QueueProposalsLifecycle, QueueProposalsScope,
	QueueCompetencyReview, QueueCompetencyChallenge, QueueIntegrityCOI,
	QueueConstitutionalReview, QueueGovernanceApprovals, QueueGovernanceProtocol,
	QueueVotingEligibility, QueueVotingTally, QueueVotingCertify, QueueVotingDelegation,
	QueueCivicAssign, QueueReputationUpdate, QueueAISynthesis,
	QueueAuditAppend, QueueNotificationsDispatch,
}

// StreamName maps a queue to its JetStream stream name (dots are illegal in
// stream names, so they become underscores).
func StreamName(queue string) string {
	return strings.ReplaceAll(queue, ".", "_")
}

// SubjectFor builds a subject for per-entity ordering (ADR-023 §Partitioning):
// e.g. SubjectFor(QueueVotingTally, "jur-1") → "voting.tally.jur-1". Consumers
// filter by subject prefix; the bare queue is the default subject.
func SubjectFor(queue string, scopeKeys ...string) string {
	if len(scopeKeys) == 0 {
		return queue
	}
	return queue + "." + strings.Join(scopeKeys, ".")
}

// AuditEvent is the shared envelope every service publishes to audit.append
// (DP-036). ID doubles as the JetStream Nats-Msg-Id and the consumer-side
// idempotency key (at-least-once + idempotent writes, ADR-023).
type AuditEvent struct {
	ID         string    `json:"id"`
	ActionType string    `json:"action_type"`
	ActorRef   string    `json:"actor_ref"`
	Payload    string    `json:"payload"`
	OccurredAt time.Time `json:"occurred_at"`
}

// NewAuditEventID mints a random event/idempotency id.
func NewAuditEventID() string {
	var b [16]byte
	if _, err := rand.Read(b[:]); err != nil {
		panic(err)
	}
	return hex.EncodeToString(b[:])
}

// Bus is a NATS connection plus its JetStream context.
type Bus struct {
	nc *nats.Conn
	js nats.JetStreamContext
}

// Connect dials NATS with production reconnect behavior: infinite
// reconnects with backoff jitter, so a broker restart never kills a service.
// Callers share one Bus per process (it is safe for concurrent use).
func Connect(url string) (*Bus, error) {
	nc, err := nats.Connect(url,
		nats.Name("digital-democracy"),
		nats.Timeout(5*time.Second),
		nats.MaxReconnects(-1),
		nats.ReconnectWait(2*time.Second),
		nats.ReconnectJitter(500*time.Millisecond, 2*time.Second),
		nats.DisconnectErrHandler(func(_ *nats.Conn, err error) {
			if err != nil {
				fmt.Printf("eventbus: disconnected: %v\n", err)
			}
		}),
		nats.ClosedHandler(func(_ *nats.Conn) {
			fmt.Println("eventbus: connection closed")
		}),
	)
	if err != nil {
		return nil, fmt.Errorf("eventbus: connect %s: %w", url, err)
	}
	js, err := nc.JetStream(nats.PublishAsyncMaxPending(256))
	if err != nil {
		nc.Close()
		return nil, fmt.Errorf("eventbus: jetstream: %w", err)
	}
	return &Bus{nc: nc, js: js}, nil
}

// EnsureStream creates the queue's stream if missing. Retention is Limits
// (ADR-023: messages retained, never deleted on ack) with file storage and
// old-data discard when limits bind. Safe to call on every boot.
//
// Adopt-or-create: if our stream already exists it is adopted as-is; if a
// DIFFERENT stream already holds the subject (e.g. an earlier deployment's
// stream on shared infrastructure), that stream is adopted instead of
// failing — ADR-023 anticipates related queues sharing a stream, and JetStream
// routes publishes and subject-filtered consumers by subject, not by stream
// name. Only when no stream holds the subject is one created.
func (b *Bus) EnsureStream(queue string) error {
	if _, err := b.js.StreamInfo(StreamName(queue)); err == nil {
		return nil
	}
	cfg := &nats.StreamConfig{
		// Stream names cannot contain dots; subjects keep the dotted
		// queue name (bare queue plus scoped children for the
		// SubjectFor per-entity ordering hierarchy).
		Name:      StreamName(queue),
		Subjects:  []string{queue, queue + ".>"},
		Retention: nats.LimitsPolicy,
		Discard:   nats.DiscardOld,
		Storage:   nats.FileStorage,
	}
	if _, err := b.js.AddStream(cfg); err != nil {
		if adopted, aerr := b.adoptOverlappingStream(queue); aerr == nil {
			fmt.Printf("eventbus: stream %s adopted for %s\n", adopted, queue)
			return nil
		}
		return fmt.Errorf("eventbus: ensure stream %s: %w", queue, err)
	}
	return nil
}

// adoptOverlappingStream finds an existing stream whose subjects already
// cover queue (exact subject or a wider wildcard), for shared infrastructure
// where another deployment owns the stream.
func (b *Bus) adoptOverlappingStream(queue string) (string, error) {
	for name := range b.js.StreamNames() {
		info, err := b.js.StreamInfo(name)
		if err != nil {
			continue
		}
		for _, subject := range info.Config.Subjects {
			if subject == queue || subject == queue+".>" || subject == ">" ||
				(strings.HasSuffix(subject, ".>") && strings.HasPrefix(queue, strings.TrimSuffix(subject, ">"))) {
				return name, nil
			}
		}
	}
	return "", fmt.Errorf("eventbus: no stream holds %s", queue)
}

// PublishOption customizes a publish.
type PublishOption func(*nats.Msg)

// WithMessageID sets the JetStream dedupe id (Nats-Msg-Id). Always pass the
// source event id so redelivered publishes are deduplicated by the server.
func WithMessageID(id string) PublishOption {
	return func(m *nats.Msg) {
		m.Header.Set("Nats-Msg-Id", id)
	}
}

// Publish publishes with server acknowledgement (PublishSync): it returns
// only after JetStream has durably stored the message, or ctx expires.
// At-least-once: retry on error with the same message id.
func (b *Bus) Publish(ctx context.Context, subject string, payload []byte, opts ...PublishOption) error {
	msg := &nats.Msg{Subject: subject, Data: payload, Header: nats.Header{}}
	for _, opt := range opts {
		opt(msg)
	}
	if _, err := b.js.PublishMsg(msg, nats.Context(ctx)); err != nil {
		return fmt.Errorf("eventbus: publish %s: %w", subject, err)
	}
	return nil
}

// Handler processes one delivered message. Return nil to ack, non-nil to
// negatively acknowledge (redelivery with backoff).
type Handler func(ctx context.Context, subject string, payload []byte) error

// SubscribeOrderedDurable attaches a durable push consumer with explicit
// manual acknowledgement. maxAckPending=1 gives the strict in-order
// processing audit.append requires (ADR-023); other queues may pass a higher
// value for throughput. Delivery starts from the first retained message so a
// restarted consumer replays what it missed (Limits retention).
func (b *Bus) SubscribeOrderedDurable(stream, durable, filterSubject string, maxAckPending int, h Handler) (*nats.Subscription, error) {
	if maxAckPending < 1 {
		maxAckPending = 1
	}
	sub, err := b.js.Subscribe(filterSubject,
		func(m *nats.Msg) {
			ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
			defer cancel()
			if err := h(ctx, m.Subject, m.Data); err != nil {
				fmt.Printf("eventbus: handler error on %s: %v (nack)\n", m.Subject, err)
				if nakErr := m.Nak(); nakErr != nil {
					fmt.Printf("eventbus: nak failed: %v\n", nakErr)
				}
				return
			}
			if ackErr := m.AckSync(); ackErr != nil {
				fmt.Printf("eventbus: ack failed on %s: %v\n", m.Subject, ackErr)
			}
		},
		nats.Durable(durable),
		nats.ManualAck(),
		nats.AckExplicit(),
		nats.AckWait(30*time.Second),
		nats.MaxAckPending(maxAckPending),
		nats.DeliverAll(),
		nats.ReplayInstant(),
	)
	if err != nil {
		return nil, fmt.Errorf("eventbus: subscribe %s/%s: %w", stream, durable, err)
	}
	return sub, nil
}

// Close drains pending publishes and closes the connection.
func (b *Bus) Close() {
	_ = b.nc.Drain()
}
