package eventbus

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
)

func (e AuditEvent) digest(secret string) []byte {
	e.Signature = ""
	body, _ := json.Marshal(e)
	mac := hmac.New(sha256.New, []byte(secret))
	_, _ = mac.Write(body)
	return mac.Sum(nil)
}
func (e *AuditEvent) Sign(producer, secret string) error {
	if secret == "" || producer == "" || e.ID == "" {
		return errors.New("audit signing credentials required")
	}
	e.Producer = producer
	e.Signature = hex.EncodeToString(e.digest(secret))
	return nil
}
func (e AuditEvent) Verify(producer, secret string) bool {
	signature, err := hex.DecodeString(e.Signature)
	return err == nil && secret != "" && e.ID != "" && e.Producer == producer && hmac.Equal(signature, e.digest(secret))
}
