package main

import (
	"os"
	"time"

	"github.com/digital-democracy/api-go/internal/audit"
	"github.com/digital-democracy/api-go/internal/auth"
	"github.com/digital-democracy/api-go/internal/delegation"
	"github.com/digital-democracy/api-go/internal/voting"
	"github.com/digital-democracy/eventbus"
)

// Seam wiring: NATS first (ADR-023), then HTTP, then nil for the package's
// hermetic default (ARCH-009). Every helper returns the package's published
// seam type so main never touches unexported implementations.

func votingAuditEmitter(bus *eventbus.Bus, httpURL string) voting.AuditEmitter {
	if bus != nil {
		return voting.NewNATSAuditEmitter(bus)
	}
	if httpURL != "" {
		return voting.NewHTTPAuditEmitter(httpURL)
	}
	return nil
}

func delegationAuditEmitter(bus *eventbus.Bus, httpURL string) delegation.AuditEmitter {
	if bus != nil {
		return delegation.NewNATSAuditEmitter(bus)
	}
	if httpURL != "" {
		return delegation.NewHTTPAuditEmitter(httpURL)
	}
	return nil
}

func authAuditEmitter(bus *eventbus.Bus, httpURL string) auth.AuditEmitter {
	if bus != nil {
		return auth.NewNATSAuditEmitter(bus)
	}
	if httpURL != "" {
		return auth.NewHTTPAuditEmitter(httpURL)
	}
	return nil
}

func delegationResolverFromEnv() voting.DelegationResolver {
	if url := os.Getenv("DELEGATION_SERVICE_URL"); url != "" {
		return voting.NewHTTPDelegationResolver(url)
	}
	// In-process default: votes count directly (DP-041 chain resolution
	// across domains is an open integration item — the session carries no
	// domain yet, so there is nothing correct to resolve against).
	return nil
}

func competencyCheckerFromEnv() delegation.CompetencyChecker {
	if url := os.Getenv("COMPETENCY_SERVICE_URL"); url != "" {
		return delegation.NewHTTPCompetencyChecker(url)
	}
	return nil
}

func identityCheckerFromEnv() auth.IdentityChecker {
	if url := os.Getenv("IDENTITY_SERVICE_URL"); url != "" {
		return auth.NewHTTPIdentityChecker(url)
	}
	return nil
}

func auditNotifierFromEnv() audit.Notifier {
	if url := os.Getenv("NOTIFICATION_SERVICE_URL"); url != "" {
		return audit.NewHTTPNotifier(url)
	}
	return nil
}

func authNotifierFromEnv() auth.Notifier {
	if url := os.Getenv("NOTIFICATION_SERVICE_URL"); url != "" {
		return auth.NewHTTPNotifier(url)
	}
	return nil
}

// delegationExpiryInterval controls how often the DP-045 sweep (delegation.
// ExpireDue) runs. DP-045's own spec says "cron, daily" -- default matches
// that; DELEGATION_EXPIRY_INTERVAL (Go duration syntax, e.g. "5m") overrides
// it for local dev/demo so expiry is observable without a real day passing.
func delegationExpiryInterval() time.Duration {
	if raw := os.Getenv("DELEGATION_EXPIRY_INTERVAL"); raw != "" {
		if d, err := time.ParseDuration(raw); err == nil && d > 0 {
			return d
		}
	}
	return 24 * time.Hour
}
