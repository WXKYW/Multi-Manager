package oracle

import "time"

type Account struct {
	ID                   int64      `json:"id"`
	Name                 string     `json:"name"`
	TenancyOCID          string     `json:"tenancyOcid"`
	UserOCID             string     `json:"userOcid"`
	Fingerprint          string     `json:"fingerprint"`
	Region               string     `json:"region"`
	PrivateKeyEncrypted  string     `json:"-"`
	PassphraseEncrypted  string     `json:"-"`
	DefaultCompartmentID string     `json:"defaultCompartmentId,omitempty"`
	Description          string     `json:"description,omitempty"`
	LastVerifiedAt       *time.Time `json:"lastVerifiedAt,omitempty"`
	LastVerifyStatus     string     `json:"lastVerifyStatus,omitempty"`
	LastVerifyError      string     `json:"lastVerifyError,omitempty"`
	CreatedAt            time.Time  `json:"createdAt"`
	UpdatedAt            time.Time  `json:"updatedAt"`
}

type accountPayload struct {
	Name                 string `json:"name"`
	TenancyOCID          string `json:"tenancyOcid"`
	UserOCID             string `json:"userOcid"`
	Fingerprint          string `json:"fingerprint"`
	Region               string `json:"region"`
	PrivateKeyPEM        string `json:"privateKeyPem"`
	Passphrase           string `json:"passphrase"`
	DefaultCompartmentID string `json:"defaultCompartmentId"`
	Description          string `json:"description"`
}

type instanceActionPayload struct {
	Action             string `json:"action"`
	PreserveBootVolume *bool  `json:"preserveBootVolume"`
}

type updateInstancePayload struct {
	Shape                   string   `json:"shape"`
	OCPUCount               *float64 `json:"ocpuCount"`
	MemoryGB                *float64 `json:"memoryGb"`
	BaselineOcpuUtilization string   `json:"baselineOcpuUtilization"`
	AvoidDowntime           *bool    `json:"avoidDowntime"`
}

type consoleConnectionPayload struct {
	PublicKey string `json:"publicKey"`
}

type NormalizedInstance struct {
	ID                 string                            `json:"id"`
	Name               string                            `json:"name"`
	State              string                            `json:"state"`
	Shape              string                            `json:"shape"`
	OCPUCount          float64                           `json:"ocpuCount,omitempty"`
	MemoryGB           float64                           `json:"memoryGb,omitempty"`
	AvailabilityDomain string                            `json:"availabilityDomain"`
	FaultDomain        string                            `json:"faultDomain,omitempty"`
	Region             string                            `json:"region"`
	TimeCreated        string                            `json:"timeCreated,omitempty"`
	ImageID            string                            `json:"imageId,omitempty"`
	PrimaryPublicIP    string                            `json:"primaryPublicIp,omitempty"`
	PrimaryPrivateIP   string                            `json:"primaryPrivateIp,omitempty"`
	CompartmentID      string                            `json:"compartmentId,omitempty"`
	IsPrimaryVNICReady bool                              `json:"isPrimaryVnicReady"`
	Metadata           map[string]string                 `json:"metadata,omitempty"`
	FreeformTags       map[string]string                 `json:"freeformTags,omitempty"`
	DefinedTags        map[string]map[string]interface{} `json:"definedTags,omitempty"`
	LaunchMode         string                            `json:"launchMode,omitempty"`
	VNICSummary        []NormalizedVNIC                  `json:"vnicSummary,omitempty"`
	BootVolumeSummary  []NormalizedVolume                `json:"bootVolumeSummary,omitempty"`
	BlockVolumeSummary []NormalizedVolume                `json:"blockVolumeSummary,omitempty"`
	ConsoleSummary     []NormalizedConsole               `json:"consoleSummary,omitempty"`
}

type NormalizedVNIC struct {
	AttachmentID  string `json:"attachmentId"`
	VNICID        string `json:"vnicId"`
	DisplayName   string `json:"displayName,omitempty"`
	SubnetID      string `json:"subnetId,omitempty"`
	PrivateIP     string `json:"privateIp,omitempty"`
	PublicIP      string `json:"publicIp,omitempty"`
	HostnameLabel string `json:"hostnameLabel,omitempty"`
	NICIndex      int    `json:"nicIndex"`
	IsPrimary     bool   `json:"isPrimary"`
	State         string `json:"state,omitempty"`
}

type NormalizedVolume struct {
	AttachmentID string `json:"attachmentId"`
	VolumeID     string `json:"volumeId"`
	VolumeType   string `json:"volumeType"`
	Device       string `json:"device,omitempty"`
	IsReadOnly   bool   `json:"isReadOnly"`
	IsShareable  bool   `json:"isShareable"`
	State        string `json:"state,omitempty"`
	TimeCreated  string `json:"timeCreated,omitempty"`
}

type NormalizedConsole struct {
	ID               string `json:"id"`
	InstanceID       string `json:"instanceId"`
	State            string `json:"state,omitempty"`
	ConnectionString string `json:"connectionString,omitempty"`
	Fingerprint      string `json:"fingerprint,omitempty"`
	TimeCreated      string `json:"timeCreated,omitempty"`
}

type ShapeRange struct {
	Min               float64 `json:"min,omitempty"`
	Max               float64 `json:"max,omitempty"`
	DefaultPerOCPU    float64 `json:"defaultPerOcpu,omitempty"`
	MinPerOCPU        float64 `json:"minPerOcpu,omitempty"`
	MaxPerOCPU        float64 `json:"maxPerOcpu,omitempty"`
	MaxPerNumaNode    float64 `json:"maxPerNumaNode,omitempty"`
	MaxPerNumaNodeGBs float64 `json:"maxPerNumaNodeGbs,omitempty"`
}

type NormalizedShape struct {
	Name                       string     `json:"name"`
	ProcessorDescription       string     `json:"processorDescription,omitempty"`
	OCPUCount                  float64    `json:"ocpuCount,omitempty"`
	MemoryGB                   float64    `json:"memoryGb,omitempty"`
	NetworkingBandwidthGbps    float64    `json:"networkingBandwidthGbps,omitempty"`
	MaxVnicAttachments         int        `json:"maxVnicAttachments,omitempty"`
	GPUCount                   int        `json:"gpuCount,omitempty"`
	LocalDiskCount             int        `json:"localDiskCount,omitempty"`
	LocalDiskTotalSizeGB       float64    `json:"localDiskTotalSizeGb,omitempty"`
	IsFlexible                 bool       `json:"isFlexible"`
	IsSubcore                  bool       `json:"isSubcore"`
	IsLiveMigrationSupported   bool       `json:"isLiveMigrationSupported"`
	IsBilledForStoppedInstance bool       `json:"isBilledForStoppedInstance"`
	BillingType                string     `json:"billingType,omitempty"`
	BaselineOcpuUtilizations   []string   `json:"baselineOcpuUtilizations,omitempty"`
	OCPUOptions                ShapeRange `json:"ocpuOptions,omitempty"`
	MemoryOptions              ShapeRange `json:"memoryOptions,omitempty"`
	ResizeCompatibleShapes     []string   `json:"resizeCompatibleShapes,omitempty"`
}
