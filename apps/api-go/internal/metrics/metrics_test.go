package metrics

import (
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestMiddlewareRecordsRequestsAndDuration(t *testing.T) {
	inner := http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusTeapot)
	})
	wrapped := Middleware("testsvc", "/testroute", inner)

	srv := httptest.NewServer(wrapped)
	defer srv.Close()

	resp, err := http.Get(srv.URL + "/testroute/anything")
	if err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()
	if resp.StatusCode != http.StatusTeapot {
		t.Fatalf("status = %d, want 418", resp.StatusCode)
	}

	metricsSrv := httptest.NewServer(Handler())
	defer metricsSrv.Close()
	body := scrape(t, metricsSrv.URL)

	if !strings.Contains(body, `http_requests_total{method="GET",route="/testroute",service="testsvc",status="418"}`) {
		t.Fatalf("http_requests_total missing expected series:\n%s", body)
	}
	if !strings.Contains(body, `http_request_duration_seconds_count{route="/testroute",service="testsvc"}`) {
		t.Fatalf("http_request_duration_seconds_count missing expected series:\n%s", body)
	}
}

func TestCriticalProcessCountersAreScraped(t *testing.T) {
	AuditLogAppendsTotal.WithLabelValues("system_update").Inc()
	VoteBallotsCastTotal.Inc()
	DelegationEventsTotal.WithLabelValues("created").Inc()
	AuthLoginAttemptsTotal.WithLabelValues("success").Inc()

	srv := httptest.NewServer(Handler())
	defer srv.Close()
	body := scrape(t, srv.URL)

	for _, want := range []string{
		"audit_log_appends_total",
		"vote_ballots_cast_total",
		"delegation_events_total",
		"auth_login_attempts_total",
	} {
		if !strings.Contains(body, want) {
			t.Fatalf("scrape output missing %q:\n%s", want, body)
		}
	}
}

func scrape(t *testing.T, url string) string {
	t.Helper()
	resp, err := http.Get(url)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	b, err := io.ReadAll(resp.Body)
	if err != nil {
		t.Fatal(err)
	}
	return string(b)
}
