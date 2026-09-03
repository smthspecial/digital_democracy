package main

import (
	"context"
	"fmt"
	"io"
	"log/slog"
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

func waitForCondition(t *testing.T, timeout time.Duration, check func() bool) {
	t.Helper()
	deadline := time.Now().Add(timeout)
	for time.Now().Before(deadline) {
		if check() {
			return
		}
		time.Sleep(20 * time.Millisecond)
	}
	t.Fatal("condition not met before timeout")
}

// TestAuditAppendConsumerAppendsToChain is ADR-023's real end-to-end proof:
// a message published to the audit.append subject on a real NATS server
// lands in the hash chain via the same Service.Append the HTTP endpoint uses.
func TestAuditAppendConsumerAppendsToChain(t *testing.T) {
	url := startNatsServer(t)
	svc := NewService(NewStore())

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	logger := slog.New(slog.NewTextHandler(io.Discard, nil))

	if err := startAuditAppendConsumer(ctx, logger, url, svc); err != nil {
		t.Fatalf("startAuditAppendConsumer: %v", err)
	}

	// Publish independently of the consumer's own connection, the way a
	// real publisher (e.g. proposal-service) would.
	bus, err := eventbus.Connect(url)
	if err != nil {
		t.Fatalf("Connect: %v", err)
	}
	defer bus.Close()
	pubCtx, pubCancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer pubCancel()
	if err := eventbus.EnsureStream(pubCtx, bus, eventbus.StreamConfig{Name: auditStreamName, Subjects: []string{auditAppendSubject}}); err != nil {
		t.Fatalf("EnsureStream: %v", err)
	}

	msg := auditAppendMessage{
		ActionType:     string(ActionProposalCreated),
		ActorRef:       "proposal-service",
		Payload:        map[string]string{"proposal_id": "p1"},
		IdempotencyKey: "idem-1",
	}
	if err := eventbus.Publish(pubCtx, bus, auditAppendSubject, msg); err != nil {
		t.Fatalf("Publish: %v", err)
	}

	waitForCondition(t, 3*time.Second, func() bool {
		return len(svc.ListLog("")) == 1
	})

	entries := svc.ListLog("")
	if len(entries) != 1 {
		t.Fatalf("expected 1 entry, got %d", len(entries))
	}
	if entries[0].ActorRef != "proposal-service" {
		t.Errorf("actor_ref = %q, want proposal-service", entries[0].ActorRef)
	}
	if entries[0].ActionType != ActionProposalCreated {
		t.Errorf("action_type = %q, want %q", entries[0].ActionType, ActionProposalCreated)
	}

	valid, _, err := svc.VerifyChainIntegrity()
	if err != nil || !valid {
		t.Errorf("expected a valid chain after consuming from the queue, valid=%v err=%v", valid, err)
	}
}

// TestAuditAppendConsumerDropsMalformedMessageWithoutBlockingLaterOnes
// proves a poison message doesn't wedge the queue -- the consumer logs and
// acks (drops) it rather than nak'ing it into infinite redelivery, and
// keeps processing subsequent messages.
func TestAuditAppendConsumerDropsMalformedMessageWithoutBlockingLaterOnes(t *testing.T) {
	url := startNatsServer(t)
	svc := NewService(NewStore())

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	logger := slog.New(slog.NewTextHandler(io.Discard, nil))

	if err := startAuditAppendConsumer(ctx, logger, url, svc); err != nil {
		t.Fatalf("startAuditAppendConsumer: %v", err)
	}

	bus, err := eventbus.Connect(url)
	if err != nil {
		t.Fatalf("Connect: %v", err)
	}
	defer bus.Close()
	pubCtx, pubCancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer pubCancel()
	if err := eventbus.EnsureStream(pubCtx, bus, eventbus.StreamConfig{Name: auditStreamName, Subjects: []string{auditAppendSubject}}); err != nil {
		t.Fatalf("EnsureStream: %v", err)
	}

	if err := eventbus.Publish(pubCtx, bus, auditAppendSubject, "not-valid-audit-append-json"); err != nil {
		t.Fatalf("Publish malformed: %v", err)
	}
	goodMsg := auditAppendMessage{ActionType: string(ActionSystemUpdate), ActorRef: "test", Payload: map[string]string{}}
	if err := eventbus.Publish(pubCtx, bus, auditAppendSubject, goodMsg); err != nil {
		t.Fatalf("Publish good: %v", err)
	}

	waitForCondition(t, 3*time.Second, func() bool {
		return len(svc.ListLog("")) == 1
	})
	entries := svc.ListLog("")
	if len(entries) != 1 {
		t.Fatalf("expected exactly 1 entry (the malformed one dropped, the good one appended), got %d", len(entries))
	}
}
