package audit

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"net/http"
	"time"

	"github.com/digital-democracy/eventbus"
	"github.com/nats-io/nats.go"
)

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

// StartAuditConsumer attaches the audit.append durable ordered consumer
// (DP-036 over ADR-023): single durable, max_ack_pending=1, strict delivery
// order, Limits-retained replay from the first message. It runs until ctx is
// cancelled; the caller owns bus lifetime.
func StartAuditConsumer(ctx context.Context, bus *eventbus.Bus, svc *Service, logger *slog.Logger) (*nats.Subscription, error) {
	if err := bus.EnsureStream(eventbus.QueueAuditAppend); err != nil {
		return nil, err
	}
	return bus.SubscribeOrderedDurable(
		eventbus.StreamName(eventbus.QueueAuditAppend),
		"audit-service",
		eventbus.QueueAuditAppend,
		1,
		func(_ context.Context, subject string, payload []byte) error {
			var evt eventbus.AuditEvent
			if err := json.Unmarshal(payload, &evt); err != nil {
				// Poison message: ack-drop with a log line. Nacking would
				// redeliver forever and — with max_ack_pending=1 — halt the
				// entire audit stream behind one malformed event.
				logger.Error("audit consumer: malformed event, dropping", "subject", subject, "error", err)
				return nil
			}
			if _, err := svc.Append(evt.ActionType, evt.ActorRef, evt.Payload, evt.ID); err != nil {
				// Unknown action verb: same poison policy as above.
				logger.Error("audit consumer: invalid event, dropping",
					"action", evt.ActionType, "id", evt.ID, "error", err)
				return nil
			}
			return nil
		},
	)
}
