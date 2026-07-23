package oracle

import (
	"context"

	"github.com/oracle/oci-go-sdk/v65/common"
	"github.com/oracle/oci-go-sdk/v65/core"
)

func (s *Service) listBootVolumes(ctx context.Context, account Account, compartmentID, availabilityDomain, instanceID string) ([]NormalizedVolume, error) {
	client, err := s.clients.compute(account)
	if err != nil {
		return nil, err
	}
	callCtx, cancel := contextWithReadTimeout(ctx)
	defer cancel()
	req := core.ListBootVolumeAttachmentsRequest{
		CompartmentId: common.String(compartmentID),
		InstanceId:    common.String(instanceID),
	}
	if availabilityDomain != "" {
		req.AvailabilityDomain = common.String(availabilityDomain)
	}
	res, err := client.ListBootVolumeAttachments(callCtx, req)
	if err != nil {
		return nil, err
	}
	items := []NormalizedVolume{}
	for _, item := range res.Items {
		items = append(items, normalizeBootVolume(item))
	}
	return items, nil
}

func (s *Service) listBlockVolumes(ctx context.Context, account Account, compartmentID, instanceID string) ([]NormalizedVolume, error) {
	client, err := s.clients.compute(account)
	if err != nil {
		return nil, err
	}
	callCtx, cancel := contextWithReadTimeout(ctx)
	defer cancel()
	res, err := client.ListVolumeAttachments(callCtx, core.ListVolumeAttachmentsRequest{
		CompartmentId: common.String(compartmentID),
		InstanceId:    common.String(instanceID),
	})
	if err != nil {
		return nil, err
	}
	items := []NormalizedVolume{}
	for _, item := range res.Items {
		items = append(items, normalizeBlockVolume(item))
	}
	return items, nil
}
