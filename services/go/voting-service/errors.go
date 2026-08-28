package main

import (
	"errors"
	"net/http"
)

var (
	ErrValidation             = errors.New("validation failed")
	ErrSessionNotFound        = errors.New("vote session not found")
	ErrSessionNotScheduled    = errors.New("vote session is not scheduled")
	ErrSessionNotOpen         = errors.New("vote session is not open")
	ErrOpenPreconditionFailed = errors.New("vote session is not yet eligible to open")
	ErrCloseNotEligible       = errors.New("vote session is not yet eligible to close")
	ErrTokenNotFound          = errors.New("eligibility token not found")
	ErrTokenUsed              = errors.New("eligibility token already used")
	ErrTallyNotAvailable      = errors.New("tally is not available until the session closes")
	ErrBallotNotFound         = errors.New("ballot not found")
)

func statusForError(err error) int {
	switch {
	case errors.Is(err, ErrValidation):
		return http.StatusBadRequest
	case errors.Is(err, ErrSessionNotFound), errors.Is(err, ErrTokenNotFound), errors.Is(err, ErrTallyNotAvailable), errors.Is(err, ErrBallotNotFound):
		return http.StatusNotFound
	case errors.Is(err, ErrSessionNotScheduled),
		errors.Is(err, ErrSessionNotOpen),
		errors.Is(err, ErrOpenPreconditionFailed),
		errors.Is(err, ErrCloseNotEligible),
		errors.Is(err, ErrTokenUsed):
		return http.StatusConflict
	default:
		return http.StatusInternalServerError
	}
}
