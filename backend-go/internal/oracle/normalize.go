package oracle

import (
	"fmt"
	"time"

	"github.com/oracle/oci-go-sdk/v65/common"
	"github.com/oracle/oci-go-sdk/v65/core"
)

func normalizeInstance(account Account, instance core.Instance, vnics []NormalizedVNIC) NormalizedInstance {
	item := NormalizedInstance{
		ID:                 stringValuePtr(instance.Id),
		Name:               stringValuePtr(instance.DisplayName),
		State:              string(instance.LifecycleState),
		Shape:              stringValuePtr(instance.Shape),
		AvailabilityDomain: stringValuePtr(instance.AvailabilityDomain),
		FaultDomain:        stringValuePtr(instance.FaultDomain),
		Region:             account.Region,
		TimeCreated:        sdkTime(instance.TimeCreated),
		ImageID:            stringValuePtr(instance.ImageId),
		CompartmentID:      stringValuePtr(instance.CompartmentId),
		Metadata:           instance.Metadata,
		FreeformTags:       instance.FreeformTags,
		DefinedTags:        instance.DefinedTags,
		LaunchMode:         string(instance.LaunchMode),
		VNICSummary:        vnics,
	}
	if instance.ShapeConfig != nil {
		item.OCPUCount = float32ValuePtr(instance.ShapeConfig.Ocpus)
		item.MemoryGB = float32ValuePtr(instance.ShapeConfig.MemoryInGBs)
	}
	if len(vnics) > 0 {
		item.IsPrimaryVNICReady = true
		for _, vnic := range vnics {
			if vnic.IsPrimary || item.PrimaryPrivateIP == "" {
				item.PrimaryPrivateIP = vnic.PrivateIP
				item.PrimaryPublicIP = vnic.PublicIP
				if vnic.IsPrimary {
					break
				}
			}
		}
	}
	return item
}

func normalizeVNIC(attachment core.VnicAttachment, vnic *core.Vnic) NormalizedVNIC {
	item := NormalizedVNIC{
		AttachmentID: stringValuePtr(attachment.Id),
		VNICID:       stringValuePtr(attachment.VnicId),
		DisplayName:  stringValuePtr(attachment.DisplayName),
		NICIndex:     intValuePtr(attachment.NicIndex),
		State:        string(attachment.LifecycleState),
	}
	if vnic != nil {
		item.DisplayName = firstNonEmpty(stringValuePtr(vnic.DisplayName), item.DisplayName)
		item.SubnetID = stringValuePtr(vnic.SubnetId)
		item.PrivateIP = stringValuePtr(vnic.PrivateIp)
		item.PublicIP = stringValuePtr(vnic.PublicIp)
		item.HostnameLabel = stringValuePtr(vnic.HostnameLabel)
		item.IsPrimary = boolValuePtr(vnic.IsPrimary)
		item.State = firstNonEmpty(string(vnic.LifecycleState), item.State)
	}
	return item
}

func normalizeBootVolume(attachment core.BootVolumeAttachment) NormalizedVolume {
	return NormalizedVolume{
		AttachmentID: stringValuePtr(attachment.Id),
		VolumeID:     stringValuePtr(attachment.BootVolumeId),
		VolumeType:   "boot",
		State:        string(attachment.LifecycleState),
		TimeCreated:  sdkTime(attachment.TimeCreated),
	}
}

func normalizeBlockVolume(attachment core.VolumeAttachment) NormalizedVolume {
	return NormalizedVolume{
		AttachmentID: stringValuePtr(attachment.GetId()),
		VolumeID:     stringValuePtr(attachment.GetVolumeId()),
		VolumeType:   "block",
		Device:       stringValuePtr(attachment.GetDevice()),
		IsReadOnly:   boolValuePtr(attachment.GetIsReadOnly()),
		IsShareable:  boolValuePtr(attachment.GetIsShareable()),
		State:        fmt.Sprint(attachment.GetLifecycleState()),
		TimeCreated:  sdkTime(attachment.GetTimeCreated()),
	}
}

func normalizeConsole(connection core.InstanceConsoleConnection) NormalizedConsole {
	return NormalizedConsole{
		ID:               stringValuePtr(connection.Id),
		InstanceID:       stringValuePtr(connection.InstanceId),
		State:            string(connection.LifecycleState),
		ConnectionString: stringValuePtr(connection.ConnectionString),
		Fingerprint:      stringValuePtr(connection.Fingerprint),
	}
}

func normalizeShape(shape core.Shape) NormalizedShape {
	item := NormalizedShape{
		Name:                       stringValuePtr(shape.Shape),
		ProcessorDescription:       stringValuePtr(shape.ProcessorDescription),
		OCPUCount:                  float32ValuePtr(shape.Ocpus),
		MemoryGB:                   float32ValuePtr(shape.MemoryInGBs),
		NetworkingBandwidthGbps:    float32ValuePtr(shape.NetworkingBandwidthInGbps),
		MaxVnicAttachments:         intValuePtr(shape.MaxVnicAttachments),
		GPUCount:                   intValuePtr(shape.Gpus),
		LocalDiskCount:             intValuePtr(shape.LocalDisks),
		LocalDiskTotalSizeGB:       float32ValuePtr(shape.LocalDisksTotalSizeInGBs),
		IsFlexible:                 boolValuePtr(shape.IsFlexible),
		IsSubcore:                  boolValuePtr(shape.IsSubcore),
		IsLiveMigrationSupported:   boolValuePtr(shape.IsLiveMigrationSupported),
		IsBilledForStoppedInstance: boolValuePtr(shape.IsBilledForStoppedInstance),
		BillingType:                string(shape.BillingType),
		BaselineOcpuUtilizations:   enumStrings(shape.BaselineOcpuUtilizations),
		ResizeCompatibleShapes:     shape.ResizeCompatibleShapes,
	}
	if shape.OcpuOptions != nil {
		item.OCPUOptions = ShapeRange{
			Min:            float32ValuePtr(shape.OcpuOptions.Min),
			Max:            float32ValuePtr(shape.OcpuOptions.Max),
			MaxPerNumaNode: float32ValuePtr(shape.OcpuOptions.MaxPerNumaNode),
		}
	}
	if shape.MemoryOptions != nil {
		item.MemoryOptions = ShapeRange{
			Min:               float32ValuePtr(shape.MemoryOptions.MinInGBs),
			Max:               float32ValuePtr(shape.MemoryOptions.MaxInGBs),
			DefaultPerOCPU:    float32ValuePtr(shape.MemoryOptions.DefaultPerOcpuInGBs),
			MinPerOCPU:        float32ValuePtr(shape.MemoryOptions.MinPerOcpuInGBs),
			MaxPerOCPU:        float32ValuePtr(shape.MemoryOptions.MaxPerOcpuInGBs),
			MaxPerNumaNodeGBs: float32ValuePtr(shape.MemoryOptions.MaxPerNumaNodeInGBs),
		}
	}
	return item
}

func sdkTime(value *common.SDKTime) string {
	if value == nil {
		return ""
	}
	return value.Time.Format(time.RFC3339)
}

func stringValuePtr(value *string) string {
	if value == nil {
		return ""
	}
	return *value
}

func intValuePtr(value *int) int {
	if value == nil {
		return 0
	}
	return *value
}

func float32ValuePtr(value *float32) float64 {
	if value == nil {
		return 0
	}
	return float64(*value)
}

func boolValuePtr(value *bool) bool {
	return value != nil && *value
}

func firstNonEmpty(values ...string) string {
	for _, value := range values {
		if value != "" {
			return value
		}
	}
	return ""
}

func enumStrings[T ~string](values []T) []string {
	items := make([]string, 0, len(values))
	for _, value := range values {
		if value != "" {
			items = append(items, string(value))
		}
	}
	return items
}
