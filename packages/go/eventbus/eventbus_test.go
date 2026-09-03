package eventbus

import (
	"context"
	"encoding/json"
	"fmt"
	"net"
	"os/exec"
	"testing"
	"time"
)

// startNatsServer spawns a real nats-server process with JetStream enabled
// on an ephemeral port, matching this codebase's "boot the real thing as a
// process, not a mock" convention (ARCH-009 §2). Requires nats-server on
// PATH (go install github.com/nats-io/nats-server/v2@latest).
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

func TestPublishAndConsumeRoundTrip(t *testing.T) {
	url := startNatsServer(t)
	bus, err := Connect(url)
	if err != nil {
		t.Fatalf("Connect: %v", err)
	}
	defer bus.Close()

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	if err := EnsureStream(ctx, bus, StreamConfig{Name: "TEST_STREAM", Subjects: []string{"test.subject"}}); err != nil {
		t.Fatalf("EnsureStream: %v", err)
	}

	type payload struct {
		Message string `json:"message"`
	}
	if err := Publish(ctx, bus, "test.subject", payload{Message: "hello"}); err != nil {
		t.Fatalf("Publish: %v", err)
	}

	received := make(chan payload, 1)
	consumeCtx, consumeCancel := context.WithCancel(context.Background())
	defer consumeCancel()

	go func() {
		_ = Consume(consumeCtx, bus, ConsumerConfig{Stream: "TEST_STREAM", Durable: "test-consumer"}, func(_ context.Context, data []byte) error {
			var p payload
			if err := json.Unmarshal(data, &p); err != nil {
				return err
			}
			received <- p
			return nil
		})
	}()

	select {
	case p := <-received:
		if p.Message != "hello" {
			t.Fatalf("got message %q, want %q", p.Message, "hello")
		}
	case <-time.After(3 * time.Second):
		t.Fatal("timed out waiting for consumed message")
	}
}

func TestConsumeRedeliversOnHandlerError(t *testing.T) {
	url := startNatsServer(t)
	bus, err := Connect(url)
	if err != nil {
		t.Fatalf("Connect: %v", err)
	}
	defer bus.Close()

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if err := EnsureStream(ctx, bus, StreamConfig{Name: "REDELIVER_STREAM", Subjects: []string{"redeliver.subject"}}); err != nil {
		t.Fatalf("EnsureStream: %v", err)
	}
	if err := Publish(ctx, bus, "redeliver.subject", map[string]string{"k": "v"}); err != nil {
		t.Fatalf("Publish: %v", err)
	}

	attempts := make(chan int, 5)
	count := 0

	consumeCtx, consumeCancel := context.WithCancel(context.Background())
	defer consumeCancel()
	go func() {
		_ = Consume(consumeCtx, bus, ConsumerConfig{
			Stream:  "REDELIVER_STREAM",
			Durable: "redeliver-consumer",
		}, func(_ context.Context, _ []byte) error {
			count++
			attempts <- count
			if count < 2 {
				return fmt.Errorf("simulated processing failure")
			}
			return nil
		})
	}()

	var last int
	for i := 0; i < 2; i++ {
		select {
		case last = <-attempts:
		case <-time.After(5 * time.Second):
			t.Fatalf("timed out waiting for attempt %d", i+1)
		}
	}
	if last != 2 {
		t.Fatalf("expected the message to be redelivered and succeed on attempt 2, got attempt %d", last)
	}
}
