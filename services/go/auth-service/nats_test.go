package main

import (
	"context"
	"encoding/json"
	"fmt"
	"net"
	"os/exec"
	"testing"
	"time"

	"github.com/digital-democracy/packages/go/eventbus"
)

// startNatsServer spawns a real nats-server process with JetStream enabled,
// matching this codebase's "boot the real thing as a process" convention
// (ARCH-009 §2). Requires nats-server on PATH
// (go install github.com/nats-io/nats-server/v2@latest).
func startNatsServer(t *testing.T) string {
	t.Helper()

	port, err := freePort()
	if err != nil {
		t.Fatalf("find free port: %v", err)
	}
	url := fmt.Sprintf("nats://127.0.0.1:%d", port)

	cmd := exec.Command("nats-server", "-p", fmt.Sprint(port), "-js", "-sd", t.TempDir())
	if err := cmd.Start(); err != nil {
		t.Skipf("nats-server not available on PATH, skipping: %v", err)
	}
	t.Cleanup(func() {
		_ = cmd.Process.Kill()
		_ = cmd.Wait()
	})

	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		conn, err := net.DialTimeout("tcp", fmt.Sprintf("127.0.0.1:%d", port), 100*time.Millisecond)
		if err == nil {
			_ = conn.Close()
			return url
		}
		time.Sleep(50 * time.Millisecond)
	}
	t.Fatal("nats-server did not start listening in time")
	return ""
}

func freePort() (int, error) {
	l, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		return 0, err
	}
	defer l.Close()
	return l.Addr().(*net.TCPAddr).Port, nil
}

func TestNATSAuditEmitterPublishesAuthEvent(t *testing.T) {
	url := startNatsServer(t)
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	emitter, err := newNATSAuditEmitter(ctx, url)
	if err != nil {
		t.Fatalf("newNATSAuditEmitter: %v", err)
	}

	now := time.Now().UTC()
	emitter.Emit(AuthEvent{
		ID:        "evt-1",
		CitizenID: "citizen-1",
		SessionID: "session-1",
		EventType: EventLoginSuccess,
		IPAddress: "203.0.113.0/24",
		CreatedAt: now,
	})

	received := make(chan map[string]any, 1)
	consumeCtx, consumeCancel := context.WithCancel(context.Background())
	defer consumeCancel()
	go func() {
		_ = eventbus.Consume(consumeCtx, emitter.bus, eventbus.ConsumerConfig{
			Stream:  auditStreamName,
			Durable: "test-consumer",
		}, func(_ context.Context, data []byte) error {
			var msg map[string]any
			if err := json.Unmarshal(data, &msg); err != nil {
				return err
			}
			received <- msg
			return nil
		})
	}()

	select {
	case msg := <-received:
		if msg["action_type"] != "system_update" {
			t.Errorf("action_type = %v, want system_update", msg["action_type"])
		}
		if msg["actor_ref"] != "auth-service" {
			t.Errorf("actor_ref = %v, want auth-service", msg["actor_ref"])
		}
		if msg["idempotency_key"] != "evt-1" {
			t.Errorf("idempotency_key = %v, want evt-1", msg["idempotency_key"])
		}
		payload, ok := msg["payload"].(map[string]any)
		if !ok {
			t.Fatalf("payload = %v, want object", msg["payload"])
		}
		if payload["citizen_id"] != "citizen-1" {
			t.Errorf("payload.citizen_id = %v, want citizen-1", payload["citizen_id"])
		}
		if payload["event_type"] != string(EventLoginSuccess) {
			t.Errorf("payload.event_type = %v, want %v", payload["event_type"], EventLoginSuccess)
		}
	case <-time.After(3 * time.Second):
		t.Fatal("timed out waiting for published message")
	}
}
