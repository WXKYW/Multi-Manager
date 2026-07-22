package cloudflare

import "testing"

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
