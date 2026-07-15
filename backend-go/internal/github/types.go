package github

import (
	"context"
	"time"
)

type Notifier interface {
	Trigger(ctx context.Context, sourceModule, eventType string, eventData map[string]interface{}) error
}

type Token struct {
	ID              int64   `json:"id"`
	Name            string  `json:"name"`
	Type            string  `json:"type"`
	TokenEncrypted  string  `json:"-"`
	Enabled         bool    `json:"enabled"`
	DefaultToken    bool    `json:"default_token"`
	Note            string  `json:"note"`
	AccountLogin    string  `json:"account_login"`
	Scopes          string  `json:"scopes"`
	PermissionsJSON string  `json:"permissions_json"`
	LastTestStatus  string  `json:"last_test_status"`
	LastTestError   string  `json:"last_test_error,omitempty"`
	LastTestAt      *string `json:"last_test_at,omitempty"`
	CreatedAt       string  `json:"created_at"`
	UpdatedAt       string  `json:"updated_at"`
}

type Repository struct {
	ID                     int64   `json:"id"`
	TokenID                *int64  `json:"token_id,omitempty"`
	Owner                  string  `json:"owner"`
	Name                   string  `json:"name"`
	FullName               string  `json:"full_name"`
	HTMLURL                string  `json:"html_url"`
	Description            string  `json:"description"`
	Private                bool    `json:"private"`
	OwnedByToken           bool    `json:"owned_by_token"`
	CanOperateActions      bool    `json:"can_operate_actions"`
	DefaultBranch          string  `json:"default_branch"`
	Language               string  `json:"language"`
	Tags                   string  `json:"tags"`
	Note                   string  `json:"note"`
	Enabled                bool    `json:"enabled"`
	NotifyEnabled          bool    `json:"notify_enabled"`
	WebhookEnabled         bool    `json:"webhook_enabled"`
	WebhookSecret          string  `json:"webhook_secret,omitempty"`
	CollectInterval        int     `json:"collect_interval_seconds"`
	RetentionDays          int     `json:"retention_days"`
	LastStatus             string  `json:"last_status"`
	LastError              string  `json:"last_error,omitempty"`
	LastCollectedAt        *string `json:"last_collected_at,omitempty"`
	LastEventFingerprint   string  `json:"-"`
	Stars                  int     `json:"stars"`
	Forks                  int     `json:"forks"`
	Watchers               int     `json:"watchers"`
	OpenIssues             int     `json:"open_issues"`
	OpenPullRequests       int     `json:"open_pull_requests"`
	LatestRelease          string  `json:"latest_release"`
	LatestReleaseURL       string  `json:"latest_release_url"`
	LatestActionStatus     string  `json:"latest_action_status"`
	LatestActionConclusion string  `json:"latest_action_conclusion"`
	LatestActionStartedAt  string  `json:"latest_action_started_at,omitempty"`
	LatestActionCreatedAt  string  `json:"latest_action_created_at,omitempty"`
	LatestActionUpdatedAt  string  `json:"latest_action_updated_at,omitempty"`
	RateLimitRemaining     int     `json:"rate_limit_remaining"`
	RateLimitReset         string  `json:"rate_limit_reset,omitempty"`
	Authenticated          bool    `json:"authenticated"`
	CreatedAt              string  `json:"created_at"`
	UpdatedAt              string  `json:"updated_at"`
}

type Settings struct {
	Enabled                 bool `json:"enabled"`
	DefaultCollectInterval  int  `json:"default_collect_interval_seconds"`
	DefaultRetentionDays    int  `json:"default_retention_days"`
	MaxConcurrentCollectors int  `json:"max_concurrent_collectors"`
	RateLimitLowThreshold   int  `json:"rate_limit_low_threshold"`
	StarSpikeThreshold      int  `json:"star_spike_threshold"`
	AutoCreateWebhookSecret bool `json:"auto_create_webhook_secret"`
}

type Snapshot struct {
	ID                  int64  `json:"id"`
	RepositoryID        int64  `json:"repository_id"`
	Stars               int    `json:"stars"`
	Forks               int    `json:"forks"`
	Watchers            int    `json:"watchers"`
	OpenIssues          int    `json:"open_issues"`
	OpenPullRequests    int    `json:"open_pull_requests"`
	CommitCount         int    `json:"commit_count"`
	ReleaseCount        int    `json:"release_count"`
	ContributorCount    int    `json:"contributor_count"`
	ActionsTotal        int    `json:"actions_total"`
	ActionsSuccess      int    `json:"actions_success"`
	ActionsFailed       int    `json:"actions_failed"`
	TrafficViews        int    `json:"traffic_views"`
	TrafficUniques      int    `json:"traffic_uniques"`
	TrafficClones       int    `json:"traffic_clones"`
	TrafficCloneUniques int    `json:"traffic_clone_uniques"`
	CollectedAt         string `json:"collected_at"`
}

type CollectorStatus struct {
	Running      bool   `json:"running"`
	LastTickAt   string `json:"last_tick_at,omitempty"`
	LastRunCount int    `json:"last_run_count"`
	LastError    string `json:"last_error,omitempty"`
}

type githubRepoResponse struct {
	ID              int64  `json:"id"`
	Name            string `json:"name"`
	FullName        string `json:"full_name"`
	Private         bool   `json:"private"`
	HTMLURL         string `json:"html_url"`
	Description     string `json:"description"`
	DefaultBranch   string `json:"default_branch"`
	Language        string `json:"language"`
	StargazersCount int    `json:"stargazers_count"`
	ForksCount      int    `json:"forks_count"`
	WatchersCount   int    `json:"watchers_count"`
	OpenIssuesCount int    `json:"open_issues_count"`
	Owner           struct {
		Login string `json:"login"`
	} `json:"owner"`
	Permissions struct {
		Admin    bool `json:"admin"`
		Maintain bool `json:"maintain"`
		Push     bool `json:"push"`
	} `json:"permissions"`
}

type workflowRunResponse struct {
	TotalCount   int `json:"total_count"`
	WorkflowRuns []struct {
		ID           int64  `json:"id"`
		Name         string `json:"name"`
		DisplayTitle string `json:"display_title"`
		Status       string `json:"status"`
		Conclusion   string `json:"conclusion"`
		Event        string `json:"event"`
		HTMLURL      string `json:"html_url"`
		Branch       string `json:"head_branch"`
		SHA          string `json:"head_sha"`
		Actor        struct {
			Login string `json:"login"`
		} `json:"actor"`
		HeadCommit struct {
			Message string `json:"message"`
		} `json:"head_commit"`
		CreatedAt    string `json:"created_at"`
		UpdatedAt    string `json:"updated_at"`
		RunStartedAt string `json:"run_started_at"`
	} `json:"workflow_runs"`
}

type workflowListResponse struct {
	TotalCount int `json:"total_count"`
	Workflows  []struct {
		ID        int64  `json:"id"`
		Name      string `json:"name"`
		Path      string `json:"path"`
		State     string `json:"state"`
		HTMLURL   string `json:"html_url"`
		BadgeURL  string `json:"badge_url"`
		CreatedAt string `json:"created_at"`
		UpdatedAt string `json:"updated_at"`
	} `json:"workflows"`
}

type branchResponse struct {
	Name      string `json:"name"`
	Protected bool   `json:"protected"`
}

type webhookResponse struct {
	ID     int64 `json:"id"`
	Config struct {
		URL string `json:"url"`
	} `json:"config"`
}

type rateLimitInfo struct {
	Limit          int
	Remaining      int
	Reset          time.Time
	OAuthScopes    string
	AcceptedScopes string
}
