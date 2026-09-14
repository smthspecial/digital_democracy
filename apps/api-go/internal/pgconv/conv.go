// Package pgconv converts between domain types and the pgtype values in
// sqlc-generated code. All converters are total on the zero value: invalid
// database NULLs become Go zero values, and Go zero values become NULLs,
// matching how the in-memory stores treat absent fields.
package pgconv

import (
	"encoding/hex"
	"math"
	"math/big"
	"strings"
	"time"

	"github.com/jackc/pgx/v5/pgtype"
)

// UUIDToString renders a database UUID as the dashed string form the domain
// layer uses for every id. Invalid (NULL) becomes "".
func UUIDToString(u pgtype.UUID) string {
	if !u.Valid {
		return ""
	}
	h := hex.EncodeToString(u.Bytes[:])
	return h[0:8] + "-" + h[8:12] + "-" + h[12:16] + "-" + h[16:20] + "-" + h[20:32]
}

// UUIDFromString parses dashed or plain-hex ids (both forms appear: dashed
// from newID, cross-app refs from callers).
func UUIDFromString(s string) (pgtype.UUID, error) {
	b, err := hex.DecodeString(strings.ReplaceAll(s, "-", ""))
	if err != nil || len(b) != 16 {
		return pgtype.UUID{}, &UUIDError{Input: s}
	}
	var a [16]byte
	copy(a[:], b)
	return pgtype.UUID{Bytes: a, Valid: true}, nil
}

// MustUUID is UUIDFromString for ids the app generated itself (always
// valid); it panics otherwise, surfacing wiring bugs loudly.
func MustUUID(s string) pgtype.UUID {
	u, err := UUIDFromString(s)
	if err != nil {
		panic(err)
	}
	return u
}

// UUIDError reports an unparseable id.
type UUIDError struct{ Input string }

func (e *UUIDError) Error() string { return "invalid uuid: " + e.Input }

// Time unwraps timestamptz (NULL → zero time).
func Time(t pgtype.Timestamptz) time.Time {
	if !t.Valid {
		return time.Time{}
	}
	return t.Time
}

// TSTZ wraps a time for a NOT NULL column.
func TSTZ(t time.Time) pgtype.Timestamptz {
	return pgtype.Timestamptz{Time: t.UTC(), Valid: true}
}

// TSTZNull wraps a time for a nullable column (zero → NULL).
func TSTZNull(t time.Time) pgtype.Timestamptz {
	if t.IsZero() {
		return pgtype.Timestamptz{}
	}
	return TSTZ(t)
}

// Text unwraps text (NULL → "").
func Text(t pgtype.Text) string {
	if !t.Valid {
		return ""
	}
	return t.String
}

// TextNull wraps a string for a nullable column ("" → NULL, preserving the
// NULL-vs-empty distinction the schema uses for optional fields).
func TextNull(s string) pgtype.Text {
	if s == "" {
		return pgtype.Text{}
	}
	return pgtype.Text{String: s, Valid: true}
}

// Float64 converts NUMERIC exactly via big.Rat, then rounds once to the
// nearest float64. The naive int*10^exp in float64 arithmetic drifts (e.g.
// 0.5 decoding as 0.5000000000000001), which would flip exact-tie quorum
// comparisons in Certify — correctness-critical, hence exact rationals.
func Float64(n pgtype.Numeric) float64 {
	if !n.Valid || n.Int == nil {
		return 0
	}
	q := new(big.Rat).SetInt(n.Int)
	ten := big.NewInt(10)
	if e := int(n.Exp); e >= 0 {
		q.Mul(q, new(big.Rat).SetInt(new(big.Int).Exp(ten, big.NewInt(int64(e)), nil)))
	} else {
		q.Quo(q, new(big.Rat).SetInt(new(big.Int).Exp(ten, big.NewInt(int64(-e)), nil)))
	}
	f, _ := q.Float64()
	return f
}

// NumericFromFloat64 stores a fraction at 1e-9 resolution — far beyond what
// quorum comparisons can distinguish.
func NumericFromFloat64(f float64) pgtype.Numeric {
	return pgtype.Numeric{Int: big.NewInt(int64(math.Round(f * 1e9))), Exp: -9, Valid: true}
}
