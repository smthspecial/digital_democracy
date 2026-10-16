package eventbus

import (
	"fmt"

	"github.com/nats-io/nats.go"
)

// TLSOptions enables verified server TLS and optionally mutual TLS. The
// certificate/key pair belongs only to this workload, never to other producers.
func TLSOptions(caFile, certFile, keyFile string) ([]nats.Option, error) {
	if (certFile == "") != (keyFile == "") {
		return nil, fmt.Errorf("broker TLS certificate and key must be configured together")
	}
	options := []nats.Option{}
	if caFile != "" {
		options = append(options, nats.RootCAs(caFile))
	}
	if certFile != "" {
		options = append(options, nats.ClientCert(certFile, keyFile))
	}
	return options, nil
}
