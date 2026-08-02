package prompts

// Collection 集合
type Collection struct {
	ID          int64  `json:"id"`
	ParentID    *int64 `json:"parent_id"`
	Name        string `json:"name"`
	Description string `json:"description"`
	Icon        string `json:"icon"`
	ColorToken  string `json:"color_token"`
	SortOrder   int    `json:"sort_order"`
	Archived    bool   `json:"archived"`
	CreatedAt   string `json:"created_at"`
	UpdatedAt   string `json:"updated_at"`
}

// EntrySummary 条目列表摘要
type EntrySummary struct {
	ID                       int64  `json:"id"`
	PublicID                 string `json:"public_id"`
	CollectionID             *int64 `json:"collection_id"`
	Title                    string `json:"title"`
	Summary                  string `json:"summary"`
	TagsJSON                 string `json:"tags_json"`
	Starred                  bool   `json:"starred"`
	Visibility               string `json:"visibility"`
	LatestPublishedVersionNo int    `json:"latest_published_version_no"`
	LatestPublishedAt        string `json:"latest_published_at"`
	CreatedAt                string `json:"created_at"`
	UpdatedAt                string `json:"updated_at"`
}

// EntryDetail 条目详情
type EntryDetail struct {
	ID                       int64  `json:"id"`
	CollectionID             *int64 `json:"collection_id"`
	Title                    string `json:"title"`
	InternalSlug             string `json:"internal_slug"`
	PublicID                 string `json:"public_id"`
	Summary                  string `json:"summary"`
	TagsJSON                 string `json:"tags_json"`
	Starred                  bool   `json:"starred"`
	Archived                 bool   `json:"archived"`
	Visibility               string `json:"visibility"`
	CurrentDraftRev          int    `json:"current_draft_rev"`
	LatestPublishedVersionID *int64 `json:"latest_published_version_id"`
	LatestPublishedVersionNo int    `json:"latest_published_version_no"`
	LatestPublishedAt        string `json:"latest_published_at"`
	PublishedCharCount       int    `json:"published_char_count"`
	PublishedWordCount       int    `json:"published_word_count"`
	CreatedAt                string `json:"created_at"`
	UpdatedAt                string `json:"updated_at"`
}

// DraftPayload 草稿
type DraftPayload struct {
	EntryID       int64  `json:"entry_id"`
	ContentMD     string `json:"content_md"`
	ContentText   string `json:"content_text"`
	OutlineJSON   string `json:"outline_json"`
	VariablesJSON string `json:"variables_json"`
	ExcerptText   string `json:"excerpt_text"`
	UpdatedAt     string `json:"updated_at"`
}

// VersionPayload 已发布版本
type VersionPayload struct {
	ID            int64  `json:"id"`
	EntryID       int64  `json:"entry_id"`
	VersionNo     int    `json:"version_no"`
	ContentMD     string `json:"content_md,omitempty"`
	ContentText   string `json:"content_text"`
	OutlineJSON   string `json:"outline_json"`
	VariablesJSON string `json:"variables_json"`
	ExcerptText   string `json:"excerpt_text"`
	Checksum      string `json:"checksum"`
	CharCount     int    `json:"char_count"`
	WordCount     int    `json:"word_count"`
	CreatedAt     string `json:"created_at"`
}

// SettingsPayload 模块设置
type SettingsPayload struct {
	DefaultVisibility      string `json:"default_visibility"`
	DefaultDirectFormat    string `json:"default_direct_format"`
	AllowPublicPages       bool   `json:"allow_public_pages"`
	AllowDirectLinks       bool   `json:"allow_direct_links"`
	AccessLogRetentionDays int    `json:"access_log_retention_days"`
}

// --- Request types ---

type CreateCollectionRequest struct {
	Name        string `json:"name"`
	ParentID    *int64 `json:"parent_id"`
	Description string `json:"description"`
}

type UpdateCollectionRequest struct {
	Name        string `json:"name"`
	Description string `json:"description"`
	ParentID    *int64 `json:"parent_id"`
	Archived    *bool  `json:"archived"`
}

type CreateEntryRequest struct {
	CollectionID *int64 `json:"collection_id"`
	Title        string `json:"title"`
	TagsJSON     string `json:"tags_json"`
	Visibility   string `json:"visibility"`
}

type UpdateEntryRequest struct {
	Title        string `json:"title"`
	CollectionID *int64 `json:"collection_id"`
	TagsJSON     string `json:"tags_json"`
	Starred      *bool  `json:"starred"`
	Archived     *bool  `json:"archived"`
	Visibility   string `json:"visibility"`
}

type SaveDraftRequest struct {
	ContentMD        string `json:"content_md"`
	ExpectedDraftRev int    `json:"expected_draft_rev"`
}

type PublishRequest struct {
	ExpectedDraftRev int `json:"expected_draft_rev"`
}

type ConflictResponse struct {
	CurrentDraftRev int    `json:"current_draft_rev"`
	Message         string `json:"message"`
}

// PublicPageData 公开页数据
type PublicPageData struct {
	Title       string `json:"title"`
	ContentHTML string `json:"content_html"`
	ContentMD   string `json:"content_md"`
	VersionNo   int    `json:"version_no"`
	PublishedAt string `json:"published_at"`
	TagsJSON    string `json:"tags_json"`
}
