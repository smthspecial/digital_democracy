package scheduler

import (
	"context"
	"errors"
	"log/slog"
	"sync/atomic"
	"testing"
	"time"
)

func TestStartRunsJobRepeatedlyUntilCancelled(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	var n int32
	Start(ctx, testLogger(), Job{
		Name:     "test-job",
		Interval: 5 * time.Millisecond,
		Run: func(context.Context) error {
			atomic.AddInt32(&n, 1)
			return nil
		},
	})

	deadline := time.Now().Add(200 * time.Millisecond)
	for time.Now().Before(deadline) {
		if atomic.LoadInt32(&n) >= 3 {
			break
		}
		time.Sleep(5 * time.Millisecond)
	}
	cancel()
	if got := atomic.LoadInt32(&n); got < 3 {
		t.Fatalf("job ran %d times, want at least 3", got)
	}

	after := atomic.LoadInt32(&n)
	time.Sleep(30 * time.Millisecond)
	if atomic.LoadInt32(&n) != after {
		t.Fatalf("job kept running after context cancellation")
	}
}

func TestStartDoesNotRunImmediately(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	var n int32
	Start(ctx, testLogger(), Job{
		Name:     "test-job",
		Interval: time.Hour,
		Run: func(context.Context) error {
			atomic.AddInt32(&n, 1)
			return nil
		},
	})
	time.Sleep(20 * time.Millisecond)
	if got := atomic.LoadInt32(&n); got != 0 {
		t.Fatalf("job ran %d times before its first interval elapsed", got)
	}
}

func TestFailedRunDoesNotStopFutureTicks(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	var n int32
	Start(ctx, testLogger(), Job{
		Name:     "test-job",
		Interval: 5 * time.Millisecond,
		Run: func(context.Context) error {
			atomic.AddInt32(&n, 1)
			return errors.New("boom")
		},
	})
	deadline := time.Now().Add(200 * time.Millisecond)
	for time.Now().Before(deadline) {
		if atomic.LoadInt32(&n) >= 3 {
			return
		}
		time.Sleep(5 * time.Millisecond)
	}
	t.Fatalf("job ran only %d times, want at least 3 despite errors", atomic.LoadInt32(&n))
}

func testLogger() *slog.Logger { return slog.Default() }
