package eventbus

import (
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/pem"
	"fmt"
	"math/big"
	"net"
	"os"
	"os/exec"
	"path/filepath"
	"testing"
	"time"

	"github.com/nats-io/nats.go"
)

// Exercise the real NATS TLS handshake and certificate-mapped workload identity.
func TestBrokerMutualTLS(t *testing.T) {
	bin, err := exec.LookPath("nats-server")
	if err != nil {
		if os.Getenv("REQUIRE_NATS_TESTS") != "" {
			t.Fatal(err)
		}
		t.Skip("nats-server unavailable")
	}
	dir := t.TempDir()
	now := time.Now()
	ca, caKey := certificate(t, dir, "ca", nil, nil, true, now.Add(time.Hour))
	_, _ = certificate(t, dir, "server", ca, caKey, false, now.Add(time.Hour))
	_, _ = certificate(t, dir, "api-go", ca, caKey, false, now.Add(time.Hour))
	_, _ = certificate(t, dir, "other-workload", ca, caKey, false, now.Add(time.Hour))
	_, _ = certificate(t, dir, "expired", ca, caKey, false, now.Add(-time.Minute))
	_, _ = certificate(t, dir, "wrong-ca", nil, nil, true, now.Add(time.Hour))
	port := freePort(t)
	cfg := fmt.Sprintf(`listen: "127.0.0.1:%d"
tls { cert_file: %q, key_file: %q, ca_file: %q, verify_and_map: true }
authorization { users: [{user: "CN=api-go", permissions: {publish: ["audit.append"], subscribe: ["audit.append"]}}] }
`, port, filepath.Join(dir, "server.pem"), filepath.Join(dir, "server.key"), filepath.Join(dir, "ca.pem"))
	path := filepath.Join(dir, "nats.conf")
	if err := os.WriteFile(path, []byte(cfg), 0600); err != nil {
		t.Fatal(err)
	}
	cmd := exec.Command(bin, "-c", path)
	if err := cmd.Start(); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = cmd.Process.Kill(); _ = cmd.Wait() })
	addr := fmt.Sprintf("127.0.0.1:%d", port)
	ready := false
	for deadline := now.Add(5 * time.Second); time.Now().Before(deadline); {
		conn, err := net.DialTimeout("tcp", addr, 100*time.Millisecond)
		if err == nil {
			_ = conn.Close()
			ready = true
			break
		}
		time.Sleep(20 * time.Millisecond)
	}
	if !ready {
		t.Fatal("TLS fixture failed startup")
	}
	cases := []struct {
		name, host, ca, client string
		success                bool
	}{
		{"verified identity", "localhost", "ca", "api-go", true},
		{"wrong server host", "127.0.0.1", "ca", "api-go", false},
		{"wrong CA", "localhost", "wrong-ca", "api-go", false},
		{"missing client certificate", "localhost", "ca", "", false},
		{"unlisted workload", "localhost", "ca", "other-workload", false},
		{"expired client certificate", "localhost", "ca", "expired", false},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			cert, key := "", ""
			if tc.client != "" {
				cert = filepath.Join(dir, tc.client+".pem")
				key = filepath.Join(dir, tc.client+".key")
			}
			options, err := TLSOptions(filepath.Join(dir, tc.ca+".pem"), cert, key)
			if err != nil {
				t.Fatal(err)
			}
			options = append(options, nats.Timeout(time.Second), nats.NoReconnect())
			bus, err := Connect(fmt.Sprintf("tls://%s:%d", tc.host, port), options...)
			if bus != nil {
				defer bus.Close()
			}
			if tc.success && err != nil {
				t.Fatal(err)
			}
			if !tc.success && err == nil {
				t.Fatal("unsafe TLS connection accepted")
			}
		})
	}
	if _, err := TLSOptions("", filepath.Join(dir, "api-go.pem"), ""); err == nil {
		t.Fatal("unpaired TLS identity accepted")
	}
	conn, err := nats.Connect("nats://"+addr, nats.Timeout(time.Second), nats.NoReconnect())
	if conn != nil {
		defer conn.Close()
	}
	// NATS advertises TLS and upgrades nats:// automatically; require actual TLS,
	// rather than assuming the scheme alone determines the negotiated transport.
	if err == nil {
		if _, tlsErr := conn.TLSConnectionState(); tlsErr != nil {
			t.Fatal("plaintext fallback accepted")
		}
	}
}

func certificate(t *testing.T, dir, name string, issuer *x509.Certificate, issuerKey *ecdsa.PrivateKey, isCA bool, until time.Time) (*x509.Certificate, *ecdsa.PrivateKey) {
	t.Helper()
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	serial, err := rand.Int(rand.Reader, new(big.Int).Lsh(big.NewInt(1), 128))
	if err != nil {
		t.Fatal(err)
	}
	cert := &x509.Certificate{SerialNumber: serial, Subject: pkix.Name{CommonName: name}, NotBefore: time.Now().Add(-time.Hour), NotAfter: until, IsCA: isCA, BasicConstraintsValid: true, KeyUsage: x509.KeyUsageDigitalSignature, ExtKeyUsage: []x509.ExtKeyUsage{x509.ExtKeyUsageClientAuth, x509.ExtKeyUsageServerAuth}}
	if isCA {
		cert.KeyUsage |= x509.KeyUsageCertSign
	} else if name == "server" {
		cert.DNSNames = []string{"localhost"}
	}
	if issuer == nil {
		issuer = cert
		issuerKey = key
	}
	der, err := x509.CreateCertificate(rand.Reader, cert, issuer, &key.PublicKey, issuerKey)
	if err != nil {
		t.Fatal(err)
	}
	parsed, err := x509.ParseCertificate(der)
	if err != nil {
		t.Fatal(err)
	}
	rawKey, err := x509.MarshalECPrivateKey(key)
	if err != nil {
		t.Fatal(err)
	}
	if err = os.WriteFile(filepath.Join(dir, name+".pem"), pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: der}), 0600); err != nil {
		t.Fatal(err)
	}
	if err = os.WriteFile(filepath.Join(dir, name+".key"), pem.EncodeToMemory(&pem.Block{Type: "EC PRIVATE KEY", Bytes: rawKey}), 0600); err != nil {
		t.Fatal(err)
	}
	return parsed, key
}
