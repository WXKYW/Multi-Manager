package cloudflare

import (
	"errors"
	"strings"
	"testing"
)

func TestCfIsResourceMissingTreatsNotFoundVariantsAsIdempotent(t *testing.T) {
	cases := map[string]bool{
		"":                       false,
		"some random API error":  false,
		"DNS record not found":   true,
		"Record does not exist.": true,
		"delete Tunnel DNS record: Record does not exist.":     true,
		"The Tunnel does not exist.":                           true,
		"delete Cloudflare Tunnel: The Tunnel does not exist.": true,
		"HTTP 404: Record does not exist.":                     true,
	}
	for message, want := range cases {
		if got := cfIsResourceMissing(errors.New(message)); got != want {
			t.Fatalf("cfIsResourceMissing(%q) = %v, want %v", message, got, want)
		}
	}
	if cfIsResourceMissing(nil) {
		t.Fatal("cfIsResourceMissing(nil) must be false")
	}
}

func TestCfIsResourceMissingIsCaseInsensitive(t *testing.T) {
	for _, message := range []string{"Record DOES NOT EXIST.", "Record Not Found"} {
		if !cfIsResourceMissing(errors.New(message)) {
			t.Fatalf("cfIsResourceMissing(%q) should be case-insensitive", message)
		}
	}
}

func TestCfIsResourceMissingDistinguishesDeletedFromOtherFailures(t *testing.T) {
	if cfIsResourceMissing(errors.New("Record exists but update failed")) {
		t.Fatal("must not treat non-missing failures as idempotent")
	}
	if !strings.Contains(errors.New("Record does not exist.").Error(), "does not exist") {
		t.Fatal("sanity: Cloudflare uses 'does not exist' phrasing")
	}
}

func TestManagedTunnelDNSOwnershipRejectsUnmanagedRecord(t *testing.T) {
	record := map[string]interface{}{"id": "dns-one", "content": "other.example.com", "comment": "created by user"}
	if err := validateManagedTunnelDNSOwnership(record, "tunnel-one.cfargotunnel.com"); err == nil {
		t.Fatal("expected unmanaged DNS record to be rejected")
	}
}

func TestManagedTunnelDNSOwnershipAcceptsMatchingOwnedRecord(t *testing.T) {
	record := map[string]interface{}{"id": "dns-one", "content": "tunnel-one.cfargotunnel.com", "comment": "Managed by API Monitor"}
	if err := validateManagedTunnelDNSOwnership(record, "tunnel-one.cfargotunnel.com"); err != nil {
		t.Fatalf("owned DNS record rejected: %v", err)
	}
}

func TestManagedTunnelDNSOwnershipAdoptsLegacyRecordPointingAtOwnTunnel(t *testing.T) {
	// A CNAME already pointing at this managed Tunnel is adoptable even when a
	// legacy record predates the ownership comment marker (e.g. ARM recovery).
	record := map[string]interface{}{"id": "dns-one", "content": "tunnel-one.cfargotunnel.com", "comment": ""}
	if err := validateManagedTunnelDNSOwnership(record, "tunnel-one.cfargotunnel.com"); err != nil {
		t.Fatalf("legacy record pointing at own Tunnel rejected: %v", err)
	}
}

func TestManagedTunnelDNSOwnershipRejectsMismatchedCommentAndContent(t *testing.T) {
	record := map[string]interface{}{"id": "dns-one", "content": "tunnel-two.cfargotunnel.com", "comment": "Managed by API Monitor"}
	if err := validateManagedTunnelDNSOwnership(record, "tunnel-one.cfargotunnel.com"); err == nil {
		t.Fatal("expected record owned by another API Monitor Tunnel to be rejected")
	}
}
