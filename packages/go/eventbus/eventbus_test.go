package eventbus

// Test harness convention (ARCH-009 §2): boot the real dependency as its own
// process, not a mock. This file's spawnNatsServer is the canonical helper
// every Go service's own nats_test.go copies rather than sharing —
// duplication is deliberate so each module stays self-contained.

import (
	"context"
	"fmt"
	"net"
	"os"
	"os/exec"
	"path/filepath"
	"sync"
	"testing"
	"time"

	"github.com/nats-io/nats.go"
)

// spawnNatsServer starts a real nats-server with JetStream on a free port.
// Skips the test when the binary is unavailable (CI installs it: see the
// go-packages job in .github/workflows/ci.yml).
func spawnNatsServer(t *testing.T) string {
	t.Helper()
	bin, err := exec.LookPath("nats-server")
	if err != nil {
		t.Skip("nats-server binary not on PATH")
	}
	port := freePort(t)
	storeDir := t.TempDir()
	// JetStream needs a writable store dir; TempDir is removed on cleanup.
	cmd := exec.Command(bin, "-js", "-p", fmt.Sprint(port), "-sd", filepath.Join(storeDir, "js"))
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

func freePort(t *testing.T) int {
	t.Helper()
	l, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer l.Close()
	return l.Addr().(*net.TCPAddr).Port
}

func TestPublishConsumeRoundTrip(t *testing.T) {
	url := spawnNatsServer(t)
	bus, err := Connect(url)
	if err != nil {
		t.Fatal(err)
	}
	defer bus.Close()
	if err := bus.EnsureStream(QueueAuditAppend); err != nil {
		t.Fatal(err)
	}

	const n = 5
	var mu sync.Mutex
	var got []string
	done := make(chan struct{})
	sub, err := bus.SubscribeOrderedDurable(StreamName(QueueAuditAppend), "test-consumer",
		QueueAuditAppend, 1, func(_ context.Context, _ string, payload []byte) error {
			mu.Lock()
			got = append(got, string(payload))
			reached := len(got) == n
			mu.Unlock()
			if reached {
				close(done)
			}
			return nil
		})
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = sub.Unsubscribe() }()

	for i := 0; i < n; i++ {
		msg := fmt.Sprintf("event-%d", i)
		if err := bus.Publish(context.Background(), QueueAuditAppend, []byte(msg), WithMessageID(msg)); err != nil {
			t.Fatal(err)
		}
	}
	select {
	case <-done:
	case <-time.After(10 * time.Second):
		t.Fatal("timed out waiting for messages")
	}
	mu.Lock()
	defer mu.Unlock()
	for i := 0; i < n; i++ {
		if got[i] != fmt.Sprintf("event-%d", i) {
			t.Fatalf("ordering violated: got %v", got)
		}
	}
}

// A redelivered publish with the same message id must not produce a
// duplicate delivery (JetStream server-side dedupe, the at-least-once half
// of ADR-023's contract; consumer-side idempotency keys are the other half).
func TestPublishDedupeByMessageID(t *testing.T) {
	url := spawnNatsServer(t)
	bus, err := Connect(url)
	if err != nil {
		t.Fatal(err)
	}
	defer bus.Close()
	if err := bus.EnsureStream(QueueNotificationsDispatch); err != nil {
		t.Fatal(err)
	}

	received := make(chan string, 10)
	sub, err := bus.SubscribeOrderedDurable(StreamName(QueueNotificationsDispatch), "dedupe-consumer",
		QueueNotificationsDispatch, 16, func(_ context.Context, _ string, payload []byte) error {
			received <- string(payload)
			return nil
		})
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = sub.Unsubscribe() }()

	ctx := context.Background()
	if err := bus.Publish(ctx, QueueNotificationsDispatch, []byte("once"), WithMessageID("dedupe-1")); err != nil {
		t.Fatal(err)
	}
	// Retry of the same logical event reuses the id: the server drops it.
	if err := bus.Publish(ctx, QueueNotificationsDispatch, []byte("once"), WithMessageID("dedupe-1")); err != nil {
		t.Fatal(err)
	}
	select {
	case m := <-received:
		if m != "once" {
			t.Fatalf("unexpected payload %q", m)
		}
	case <-time.After(10 * time.Second):
		t.Fatal("no message received")
	}
	select {
	case m := <-received:
		t.Fatalf("duplicate delivery: %q", m)
	case <-time.After(2 * time.Second):
	}
}

// On shared infrastructure another deployment may already own a stream
// covering the subject (e.g. a legacy AUDIT stream). EnsureStream must adopt
// it instead of failing, and publish/consume keep working by subject.
func TestEnsureStreamAdoptsOverlapping(t *testing.T) {
	url := spawnNatsServer(t)
	bus, err := Connect(url)
	if err != nil {
		t.Fatal(err)
	}
	defer bus.Close()

	legacy, err := bus.js.AddStream(&nats.StreamConfig{
		Name:     "LEGACY",
		Subjects: []string{"audit.append"},
		Storage:  nats.MemoryStorage,
	})
	_ = legacy
	if err != nil {
		t.Fatalf("seed legacy stream: %v", err)
	}
	if err := bus.EnsureStream(QueueAuditAppend); err != nil {
		t.Fatalf("EnsureStream with overlapping stream: %v", err)
	}
	ctx := context.Background()
	if err := bus.Publish(ctx, QueueAuditAppend, []byte("adopted"), WithMessageID("adopt-1")); err != nil {
		t.Fatalf("publish via adopted stream: %v", err)
	}
}

func TestSubjectFor(t *testing.T) {
	if got := SubjectFor(QueueVotingTally); got != "voting.tally" {
		t.Fatalf("bare subject = %q", got)
	}
	if got := SubjectFor(QueueVotingTally, "jur-1"); got != "voting.tally.jur-1" {
		t.Fatalf("scoped subject = %q", got)
	}
	if got := StreamName(QueueAuditAppend); got != "audit_append" {
		t.Fatalf("stream name = %q", got)
	}
}
