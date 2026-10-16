// Synthetic TASK-007 feasibility experiment. Nothing here is compiled into
// either API. In-memory policy checks do not qualify durable issuance/spending,
// network anonymity, receipt-freeness, or the complete voting protocol.
package cryptography_test

import (
	"bytes"
	"crypto"
	"crypto/rand"
	"crypto/rsa"
	"crypto/sha256"
	"crypto/sha512"
	"errors"
	"sync"
	"sync/atomic"
	"testing"

	"github.com/cloudflare/circl/blindsign/blindrsa"
)

const domain = "dd/experimental-election-credential/v1\x00"

var denied = errors.New("credential denied")

// Issuer and collector deliberately share no citizen-to-token table. Each
// election uses a dedicated, pre-pinned key common to all its voters. Merely
// putting the election in a blind message cannot constrain the blind signer.
type issuer struct {
	mu      sync.Mutex
	signer  blindrsa.Signer
	modulus []byte
	issued  map[string]issuance
}

type issuance struct{ request, response []byte }

func (i *issuer) issue(citizen string, blinded []byte) ([]byte, error) {
	i.mu.Lock()
	defer i.mu.Unlock()
	// A synthetic eligibility fixture, not real citizen authentication.
	if citizen != "eligible-a" && citizen != "eligible-b" {
		return nil, denied
	}
	// Reject unusable representatives before consuming the single issuance.
	if len(blinded) != len(i.modulus) || bytes.Equal(blinded, make([]byte, len(blinded))) || bytes.Compare(blinded, i.modulus) >= 0 {
		return nil, denied
	}
	if previous, ok := i.issued[citizen]; ok {
		if !bytes.Equal(previous.request, blinded) {
			return nil, denied
		}
		return bytes.Clone(previous.response), nil
	}
	response, err := i.signer.BlindSign(blinded)
	if err != nil {
		return nil, denied
	}
	i.issued[citizen] = issuance{bytes.Clone(blinded), bytes.Clone(response)}
	return response, nil
}

// The anonymous collector receives only the prepared token and signature.
// This lock models atomic spending locally; it is not a database transaction.
type collector struct {
	mu       sync.Mutex
	key      *rsa.PublicKey
	manifest [32]byte
	spent    map[[32]byte]bool
}

func (c *collector) redeem(prepared, signature []byte) error {
	// RFC 9474 randomized Prepare prepends 32 bytes. Require the fixed
	// application domain, manifest hash and a client-generated 32-byte nonce.
	prefix := append([]byte(domain), c.manifest[:]...)
	if len(prepared) != 32+len(prefix)+32 || !bytes.Equal(prepared[32:32+len(prefix)], prefix) {
		return denied
	}
	digest := sha512.Sum384(prepared)
	if rsa.VerifyPSS(c.key, crypto.SHA384, digest[:], signature,
		&rsa.PSSOptions{SaltLength: crypto.SHA384.Size()}) != nil {
		return denied
	}
	// Exclude the signature AND randomized Prepare prefix: signing the same
	// token with new randomness must not create a second spendable token.
	nullifier := sha256.Sum256(prepared[32:])
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.spent[nullifier] {
		return denied
	}
	c.spent[nullifier] = true
	return nil
}

type request struct {
	client            blindrsa.Client
	prepared, blinded []byte
	state             blindrsa.State
}

func prepare(t *testing.T, key *rsa.PublicKey, manifest [32]byte, nonce []byte) request {
	t.Helper()
	client, err := blindrsa.NewClient(blindrsa.SHA384PSSRandomized, key)
	if err != nil {
		t.Fatal(err)
	}
	message := append(append([]byte(domain), manifest[:]...), nonce...)
	prepared, err := client.Prepare(rand.Reader, message)
	if err != nil {
		t.Fatal(err)
	}
	blinded, state, err := client.Blind(rand.Reader, prepared)
	if err != nil {
		t.Fatal(err)
	}
	return request{client, prepared, blinded, state}
}

func nonce() []byte {
	value := make([]byte, 32)
	rand.Read(value)
	return value
}

func finish(t *testing.T, i *issuer, citizen string, req request) []byte {
	t.Helper()
	response, err := i.issue(citizen, req.blinded)
	if err != nil {
		t.Fatal(err)
	}
	signature, err := req.client.Finalize(req.state, response)
	if err != nil {
		t.Fatal(err)
	}
	return signature
}

func TestBlindCredentialExperiment(t *testing.T) {
	key, err := rsa.GenerateKey(rand.Reader, 3072)
	if err != nil {
		t.Fatal(err)
	}
	otherKey, err := rsa.GenerateKey(rand.Reader, 3072)
	if err != nil {
		t.Fatal(err)
	}
	manifest := sha256.Sum256([]byte("synthetic frozen election A manifest"))
	otherManifest := sha256.Sum256([]byte("synthetic frozen election B manifest"))
	newIssuer := func() *issuer {
		return &issuer{signer: blindrsa.NewSigner(key), modulus: key.N.Bytes(), issued: map[string]issuance{}}
	}
	newCollector := func() *collector {
		return &collector{key: &key.PublicKey, manifest: manifest, spent: map[[32]byte]bool{}}
	}
	newRequest := func() request { return prepare(t, &key.PublicKey, manifest, nonce()) }

	t.Run("blind issuance and independent RSA-PSS verification", func(t *testing.T) {
		i, c, req := newIssuer(), newCollector(), newRequest()
		sig := finish(t, i, "eligible-a", req)
		if err := c.redeem(req.prepared, sig); err != nil {
			t.Fatal(err)
		}
		// Structural separation only; not an empirical proof of unlinkability.
		if bytes.Contains(i.issued["eligible-a"].request, req.prepared) {
			t.Fatal("issuer received the unblinded credential")
		}
	})

	t.Run("ineligible citizen and replacement issuance rejected", func(t *testing.T) {
		i, req := newIssuer(), newRequest()
		if _, err := i.issue("ineligible", req.blinded); err == nil {
			t.Fatal("ineligible issuance")
		}
		first, err := i.issue("eligible-a", req.blinded)
		if err != nil {
			t.Fatal(err)
		}
		retry, err := i.issue("eligible-a", req.blinded)
		if err != nil || !bytes.Equal(first, retry) {
			t.Fatal("exact retry changed issuance")
		}
		if _, err := i.issue("eligible-a", newRequest().blinded); err == nil {
			t.Fatal("second issuance")
		}
	})

	t.Run("malformed request does not consume eligibility", func(t *testing.T) {
		i := newIssuer()
		for _, bad := range [][]byte{nil, {1}, make([]byte, key.Size()), key.N.Bytes(), bytes.Repeat([]byte{255}, key.Size())} {
			if _, err := i.issue("eligible-a", bad); err == nil {
				t.Fatal("malformed request signed")
			}
		}
		finish(t, i, "eligible-a", newRequest())
	})

	t.Run("tampering and alternate election keys rejected", func(t *testing.T) {
		req := newRequest()
		sig := finish(t, newIssuer(), "eligible-a", req)
		badMessage, badSig := bytes.Clone(req.prepared), bytes.Clone(sig)
		badMessage[len(badMessage)-1] ^= 1
		badSig[0] ^= 1
		cases := []struct {
			name               string
			message, signature []byte
			publicKey          *rsa.PublicKey
			context            [32]byte
		}{
			{"changed token", badMessage, sig, &key.PublicKey, manifest},
			{"changed signature", req.prepared, badSig, &key.PublicKey, manifest},
			{"short signature", req.prepared, sig[:len(sig)-1], &key.PublicKey, manifest},
			{"trailing message", append(bytes.Clone(req.prepared), 0), sig, &key.PublicKey, manifest},
			{"empty message", nil, sig, &key.PublicKey, manifest},
			{"other manifest", req.prepared, sig, &key.PublicKey, otherManifest},
			{"other signing key", req.prepared, sig, &otherKey.PublicKey, manifest},
		}
		for _, tc := range cases {
			t.Run(tc.name, func(t *testing.T) {
				c := &collector{key: tc.publicKey, manifest: tc.context, spent: map[[32]byte]bool{}}
				if err := c.redeem(tc.message, tc.signature); err == nil {
					t.Fatal("invalid credential accepted")
				}
				if len(c.spent) != 0 {
					t.Fatal("failed verification consumed a token")
				}
			})
		}
	})

	t.Run("blind signer cannot authorize another election", func(t *testing.T) {
		// A malicious eligible client asks A to sign B's hidden manifest.
		req := prepare(t, &key.PublicKey, otherManifest, nonce())
		sig := finish(t, newIssuer(), "eligible-a", req)
		if err := newCollector().redeem(req.prepared, sig); err == nil {
			t.Fatal("A accepted B context")
		}
		b := &collector{key: &otherKey.PublicKey, manifest: otherManifest, spent: map[[32]byte]bool{}}
		if err := b.redeem(req.prepared, sig); err == nil {
			t.Fatal("B accepted A signature")
		}
	})

	t.Run("concurrent issuance grants at most one distinct request", func(t *testing.T) {
		i := newIssuer()
		requests := []request{newRequest(), newRequest()}
		var successes atomic.Int32
		var wg sync.WaitGroup
		for _, req := range requests {
			wg.Go(func() {
				if _, err := i.issue("eligible-a", req.blinded); err == nil {
					successes.Add(1)
				}
			})
		}
		wg.Wait()
		if successes.Load() != 1 {
			t.Fatal("multiple credentials issued")
		}
	})

	t.Run("concurrent redemption spends exactly once", func(t *testing.T) {
		c, req := newCollector(), newRequest()
		sig := finish(t, newIssuer(), "eligible-a", req)
		var successes atomic.Int32
		var wg sync.WaitGroup
		for range 32 {
			wg.Go(func() {
				if err := c.redeem(req.prepared, sig); err == nil {
					successes.Add(1)
				}
			})
		}
		wg.Wait()
		if successes.Load() != 1 || len(c.spent) != 1 {
			t.Fatal("double spend")
		}
	})

	t.Run("new preparation and signature do not bypass spent nonce", func(t *testing.T) {
		i, c, nonce := newIssuer(), newCollector(), nonce()
		first := prepare(t, &key.PublicKey, manifest, nonce)
		second := prepare(t, &key.PublicKey, manifest, nonce)
		sig1 := finish(t, i, "eligible-a", first)
		sig2 := finish(t, i, "eligible-b", second)
		if bytes.Equal(first.prepared, second.prepared) || bytes.Equal(sig1, sig2) {
			t.Fatal("randomized preparation repeated")
		}
		if err := c.redeem(first.prepared, sig1); err != nil {
			t.Fatal(err)
		}
		if err := c.redeem(second.prepared, sig2); err == nil {
			t.Fatal("new randomness bypassed spent token")
		}
	})

	t.Run("corrupt issuer response rejected by client", func(t *testing.T) {
		req := newRequest()
		response, err := newIssuer().issue("eligible-a", req.blinded)
		if err != nil {
			t.Fatal(err)
		}
		response[0] ^= 1
		if _, err := req.client.Finalize(req.state, response); err == nil {
			t.Fatal("corrupt issuer response accepted")
		}
	})

	t.Run("transferable bearer credential remains an explicit limitation", func(t *testing.T) {
		req := newRequest()
		sig := finish(t, newIssuer(), "eligible-a", req)
		// A thief/coercer with the credential can redeem it. Blind signatures
		// alone MUST NOT be described as coercion-resistant authentication.
		if err := newCollector().redeem(bytes.Clone(req.prepared), bytes.Clone(sig)); err != nil {
			t.Fatal(err)
		}
	})
}
