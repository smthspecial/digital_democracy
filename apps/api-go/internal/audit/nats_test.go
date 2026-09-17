package audit

// NATS consumer test (ADR-023). Harness convention per ARCH-009 §2: boot a
// real nats-server as a process — copied helper, deliberately not shared.

import (
	"context"
	"encoding/json"
	"fmt"
	"net"
	"os"
	"os/exec"
	"path/filepath"
	"testing"
	"time"

	"github.com/digital-democracy/eventbus"
)

func spawnNatsServer(t *testing.T) string {
	t.Helper()
	bin, err := exec.LookPath("nats-server")
	if err != nil {
		// TI-04: CI sets REQUIRE_NATS_TESTS after installing nats-server
		// explicitly -- a skip there means the install step itself broke,
		// which must fail loudly rather than quietly report green with this
		// test not run (the same silent-skip shape the audit-emitter bug
		// hid behind).
		if os.Getenv("REQUIRE_NATS_TESTS") != "" {
			t.Fatalf("nats-server binary not on PATH, but REQUIRE_NATS_TESTS is set: %v", err)
		}
		t.Skip("nats-server binary not on PATH")
	}
	l, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	port := l.Addr().(*net.TCPAddr).Port
	_ = l.Close()
	cmd := exec.Command(bin, "-js", "-p", fmt.Sprint(port), "-sd", filepath.Join(t.TempDir(), "js"))
	cmd.Stdout = os.Stderr
	cmd.Stderr = os.Stderr
	if err := cmd.Start(); err != nil {
		t.Fatalf("start nats-server: %v", err)
	}
	t.Cleanup(func() {
		_ = cmd.Process.Kill()
		_ = cmd.Wait()
	})
	addr := fmt.Sprintf("127.0.0.1:%d", port)
	deadline := time.Now().Add(10 * time.Second)
	for time.Now().Before(deadline) {
		conn, err := net.DialTimeout("tcp", addr, 200*time.Millisecond)
		if err == nil {
			_ = conn.Close()
			return "nats://" + addr
		}
		time.Sleep(100 * time.Millisecond)
	}
	t.Fatal("nats-server did not become ready")
	return ""
}

// End-to-end over a real broker: published audit events land hash-chained in
// the store, and redeliveries dedupe on the event id.
func TestAuditConsumerRoundTrip(t *testing.T) {
	url := spawnNatsServer(t)
	bus, err := eventbus.Connect(url)
	if err != nil {
		t.Fatal(err)
	}
	defer bus.Close()

	svc := NewService(nil, nil)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	sub, err := StartAuditConsumer(ctx, bus, svc, testLogger())
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = sub.Unsubscribe() }()

	publish := func(id, action string) {
		evt := eventbus.AuditEvent{
			ID: id, ActionType: action, ActorRef: "test", Payload: "p-" + id, OccurredAt: time.Now().UTC(),
		}
		body, _ := json.Marshal(evt)
		if err := bus.Publish(context.Background(), eventbus.QueueAuditAppend, body, eventbus.WithMessageID(id)); err != nil {
			t.Fatalf("publish: %v", err)
		}
	}
	publish("e1", "proposal_created")
	publish("e2", "vote_certified")
	publish("e1", "proposal_created") // redelivery: same id

	countIs := func(want int) bool {
		n, err := svc.store.Count()
		return err == nil && n == want
	}
	deadline := time.Now().Add(10 * time.Second)
	for time.Now().Before(deadline) {
		if countIs(2) {
			break
		}
		time.Sleep(50 * time.Millisecond)
	}
	if !countIs(2) {
		n, _ := svc.store.Count()
		t.Fatalf("entries = %d, want 2 (deduplicated)", n)
	}
	ok, bad, err := svc.store.VerifyChain()
	if err != nil {
		t.Fatal(err)
	}
	if !ok {
		t.Fatalf("chain invalid at %d", bad)
	}
}
