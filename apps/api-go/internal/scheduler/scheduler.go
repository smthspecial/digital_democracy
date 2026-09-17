// Package scheduler runs periodic in-process jobs (ADR-027: one binary per
// runtime, no separate scheduler service/container -- jobs run inside the
// same api-go process docker-compose/the Helm chart already deploys).
package scheduler

import (
	"context"
	"log/slog"
	"time"
)

type Job struct {
	Name     string
	Interval time.Duration
	// Run executes one sweep. Errors are logged, never fatal -- one failed
	// tick must not stop future ticks or the server itself.
	Run func(ctx context.Context) error
}

// Start launches one goroutine per job, each ticking at its own interval
// until ctx is cancelled. The first run happens after one interval elapses,
// not immediately at boot.
func Start(ctx context.Context, logger *slog.Logger, jobs ...Job) {
	for _, j := range jobs {
		go run(ctx, logger, j)
	}
}

func run(ctx context.Context, logger *slog.Logger, j Job) {
	ticker := time.NewTicker(j.Interval)
	defer ticker.Stop()
	logger.Info("scheduler: job registered", "job", j.Name, "interval", j.Interval.String())
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			if err := j.Run(ctx); err != nil {
				logger.Error("scheduler: job failed", "job", j.Name, "error", err)
			}
		}
	}
}
