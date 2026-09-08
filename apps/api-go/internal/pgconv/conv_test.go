package pgconv

import (
	"math/big"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgtype"
)

func TestUUIDRoundTrip(t *testing.T) {
	for _, id := range []string{
		"6dc48445-ad52-4d2b-824b-17e59f32c6c4",
		"6dc48445ad524d2b824b17e59f32c6c4",
	} {
		u, err := UUIDFromString(id)
		if err != nil || !u.Valid {
			t.Fatalf("parse %q: %v", id, err)
		}
		back := UUIDToString(u)
		if back != "6dc48445-ad52-4d2b-824b-17e59f32c6c4" {
			t.Fatalf("round trip %q = %q", id, back)
		}
	}
	if _, err := UUIDFromString("not-a-uuid"); err == nil {
		t.Fatal("invalid uuid must fail")
	}
	if got := UUIDToString(pgtype.UUID{}); got != "" {
		t.Fatalf("NULL uuid = %q", got)
	}
}

func TestFloat64Exact(t *testing.T) {
	for _, f := range []float64{0, 0.5, 0.9, 1, 0.1, 0.666666667} {
		if got := Float64(NumericFromFloat64(f)); got != f {
			t.Fatalf("round trip %v = %v", f, got)
		}
	}
	// Hand-built NUMERIC as the server sends it: 0.5 exactly.
	n := pgtype.Numeric{Int: big.NewInt(5), Exp: -1, Valid: true}
	if got := Float64(n); got != 0.5 {
		t.Fatalf("0.5 decoded as %v", got)
	}
	if got := Float64(pgtype.Numeric{}); got != 0 {
		t.Fatalf("NULL numeric = %v", got)
	}
}

func TestNullHelpers(t *testing.T) {
	if Text(TextNull("")) != "" || !TextNull("x").Valid {
		t.Fatal("text null mapping")
	}
	if Time(TSTZNull(time.Time{})).IsZero() == false || TSTZNull(time.Time{}).Valid {
		t.Fatal("zero time must map to NULL")
	}
}
