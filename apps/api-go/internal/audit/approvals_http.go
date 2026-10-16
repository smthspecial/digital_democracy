package audit

import (
	"encoding/json"
	"fmt"
	"github.com/digital-democracy/api-go/internal/security"
	"io"
	"net/http"
	"net/url"
	"os"
	"time"
)

func protocolApprovals(changeRef string) ([]ProtocolApproval, error) {
	base, secret := os.Getenv("GOVERNANCE_SERVICE_URL"), os.Getenv("INTERNAL_SERVICE_SHARED_SECRET")
	if base == "" || secret == "" {
		return nil, fmt.Errorf("approval verifier is not configured")
	}
	req, err := http.NewRequest("GET", base+"/governance-role/actions/"+url.PathEscape(changeRef)+"/protocol-approvals", nil)
	if err != nil {
		return nil, err
	}
	security.Sign(req, "api-go", secret, nil)
	resp, err := (&http.Client{Timeout: 3 * time.Second}).Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != 200 {
		return nil, fmt.Errorf("approval source returned %d", resp.StatusCode)
	}
	var out struct {
		Approvals []ProtocolApproval `json:"approvals"`
	}
	if err = json.NewDecoder(io.LimitReader(resp.Body, 8192)).Decode(&out); err != nil {
		return nil, err
	}
	if len(out.Approvals) != 3 {
		return nil, fmt.Errorf("three independent approvals required")
	}
	actors, types := map[string]bool{}, map[string]bool{}
	for _, a := range out.Approvals {
		if a.ApproverRef == "" || actors[a.ApproverRef] || types[a.Ref] || (a.Ref != "citizen_supermajority" && a.Ref != "audit_confirmation" && a.Ref != "body_endorsement") {
			return nil, fmt.Errorf("invalid independent approvals")
		}
		actors[a.ApproverRef] = true
		types[a.Ref] = true
	}
	return out.Approvals, nil
}
