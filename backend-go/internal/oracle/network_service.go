package oracle

import (
	"context"

	"github.com/oracle/oci-go-sdk/v65/common"
	"github.com/oracle/oci-go-sdk/v65/core"
	"github.com/oracle/oci-go-sdk/v65/identity"
)

func (s *Service) listCompartments(ctx context.Context, account Account) ([]map[string]interface{}, error) {
	client, err := s.clients.identity(account)
	if err != nil {
		return nil, err
	}
	callCtx, cancel := contextWithReadTimeout(ctx)
	defer cancel()
	res, err := client.ListCompartments(callCtx, identity.ListCompartmentsRequest{
		CompartmentId:          common.String(account.TenancyOCID),
		CompartmentIdInSubtree: common.Bool(true),
		AccessLevel:            identity.ListCompartmentsAccessLevelAccessible,
		LifecycleState:         identity.CompartmentLifecycleStateActive,
	})
	if err != nil {
		return nil, err
	}
	items := []map[string]interface{}{
		{"id": account.TenancyOCID, "name": "根租户", "description": account.Name, "lifecycleState": "ACTIVE"},
	}
	for _, item := range res.Items {
		items = append(items, map[string]interface{}{
			"id":             stringValuePtr(item.Id),
			"name":           stringValuePtr(item.Name),
			"description":    stringValuePtr(item.Description),
			"lifecycleState": string(item.LifecycleState),
			"timeCreated":    sdkTime(item.TimeCreated),
		})
	}
	return items, nil
}

func (s *Service) listAvailabilityDomains(ctx context.Context, account Account, compartmentID string) ([]map[string]interface{}, error) {
	client, err := s.clients.identity(account)
	if err != nil {
		return nil, err
	}
	callCtx, cancel := contextWithReadTimeout(ctx)
	defer cancel()
	res, err := client.ListAvailabilityDomains(callCtx, identity.ListAvailabilityDomainsRequest{CompartmentId: common.String(firstNonEmpty(compartmentID, account.TenancyOCID))})
	if err != nil {
		return nil, err
	}
	items := []map[string]interface{}{}
	for _, item := range res.Items {
		items = append(items, map[string]interface{}{
			"id":   stringValuePtr(item.Id),
			"name": stringValuePtr(item.Name),
		})
	}
	return items, nil
}

func (s *Service) listVNICs(ctx context.Context, account Account, compartmentID, instanceID string) ([]NormalizedVNIC, error) {
	compute, err := s.clients.compute(account)
	if err != nil {
		return nil, err
	}
	network, err := s.clients.network(account)
	if err != nil {
		return nil, err
	}
	callCtx, cancel := contextWithReadTimeout(ctx)
	defer cancel()
	attachments, err := compute.ListVnicAttachments(callCtx, core.ListVnicAttachmentsRequest{
		CompartmentId: common.String(compartmentID),
		InstanceId:    common.String(instanceID),
	})
	if err != nil {
		return nil, err
	}
	items := []NormalizedVNIC{}
	for _, attachment := range attachments.Items {
		var vnic *core.Vnic
		if attachment.VnicId != nil {
			detail, err := network.GetVnic(callCtx, core.GetVnicRequest{VnicId: attachment.VnicId})
			if err == nil {
				vnic = &detail.Vnic
			}
		}
		items = append(items, normalizeVNIC(attachment, vnic))
	}
	return items, nil
}
