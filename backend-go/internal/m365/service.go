package m365

import (
	"context"
	"database/sql"
	"encoding/csv"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"strconv"
	"strings"
	"time"

	"github.com/iwvw/api-monitor/backend-go/internal/config"
	"github.com/iwvw/api-monitor/backend-go/internal/database"
	"github.com/iwvw/api-monitor/backend-go/internal/response"
	"github.com/iwvw/api-monitor/backend-go/internal/secure"
)

const (
	defaultGraphBase = "https://graph.microsoft.com/v1.0"
	defaultLoginBase = "https://login.microsoftonline.com"
	requestTimeout   = 30 * time.Second
)

var (
	errAccountNotFound = errors.New("account not found")
	reportTypeMap      = map[string]string{
		"office-activity":   "getOffice365ActiveUserDetail",
		"m365-apps":         "getM365AppUserDetail",
		"onedrive-usage":    "getOneDriveUsageAccountDetail",
		"mailbox-usage":     "getMailboxUsageDetail",
	}
)

type Service struct {
	cfg       config.Config
	store     *database.Store
	client    *http.Client
	graphBase string
	loginBase string
}

type accountRecord struct {
	ID              int64
	Name            string
	TenantID        string
	ClientID        string
	ClientSecret    string
	Description     string
	DefaultDomain   string
	Organization    string
	Enabled         bool
	LastVerifiedAt  string
	LastVerifiedErr string
	CreatedAt       string
	UpdatedAt       string
}

type reportCacheRecord struct {
	Summary  map[string]interface{} `json:"summary"`
	Rows     []map[string]string    `json:"rows"`
	CachedAt string                 `json:"cachedAt"`
}

type graphErrorEnvelope struct {
	Error struct {
		Code    string `json:"code"`
		Message string `json:"message"`
	} `json:"error"`
}

func New(cfg config.Config) *Service {
	service := &Service{
		cfg:       cfg,
		store:     database.New(cfg),
		client:    &http.Client{Timeout: requestTimeout},
		graphBase: envURL("M365_GRAPH_BASE_URL", defaultGraphBase),
		loginBase: envURL("M365_LOGIN_BASE_URL", defaultLoginBase),
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if db, err := service.open(ctx); err == nil {
		db.Close()
	}
	return service
}

func (s *Service) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	path := strings.TrimPrefix(r.URL.EscapedPath(), "/api/m365")
	path = strings.Trim(path, "/")
	parts := []string{}
	if path != "" {
		parts = strings.Split(path, "/")
		for i, part := range parts {
			if unescaped, err := url.PathUnescape(part); err == nil {
				parts[i] = unescaped
			}
		}
	}

	switch {
	case len(parts) == 1 && parts[0] == "accounts":
		s.accounts(w, r)
	case len(parts) == 2 && parts[0] == "accounts" && (r.Method == http.MethodPut || r.Method == http.MethodDelete):
		s.accountMutation(w, r, parts[1])
	case len(parts) == 3 && parts[0] == "accounts" && parts[2] == "verify" && r.Method == http.MethodPost:
		s.verifyAccount(w, r, parts[1])
	case len(parts) == 3 && parts[0] == "accounts" && parts[2] == "organization" && r.Method == http.MethodGet:
		s.organization(w, r, parts[1])
	case len(parts) == 3 && parts[0] == "accounts" && parts[2] == "users":
		s.users(w, r, parts[1])
	case len(parts) == 4 && parts[0] == "accounts" && parts[2] == "users" && r.Method == http.MethodGet:
		s.userDetails(w, r, parts[1], parts[3])
	case len(parts) == 4 && parts[0] == "accounts" && parts[2] == "users" && (r.Method == http.MethodPatch || r.Method == http.MethodDelete):
		s.userMutation(w, r, parts[1], parts[3])
	case len(parts) == 5 && parts[0] == "accounts" && parts[2] == "users" && parts[4] == "license-details" && r.Method == http.MethodGet:
		s.userLicenseDetails(w, r, parts[1], parts[3])
	case len(parts) == 5 && parts[0] == "accounts" && parts[2] == "users" && parts[4] == "assign-license" && r.Method == http.MethodPost:
		s.assignUserLicense(w, r, parts[1], parts[3])
	case len(parts) == 4 && parts[0] == "accounts" && parts[2] == "licenses" && parts[3] == "skus" && r.Method == http.MethodGet:
		s.listSKUs(w, r, parts[1])
	case len(parts) == 3 && parts[0] == "accounts" && parts[2] == "groups":
		s.groups(w, r, parts[1])
	case len(parts) == 5 && parts[0] == "accounts" && parts[2] == "groups" && parts[4] == "members" && r.Method == http.MethodGet:
		s.groupMembers(w, r, parts[1], parts[3])
	case len(parts) == 6 && parts[0] == "accounts" && parts[2] == "groups" && parts[4] == "members" && r.Method == http.MethodPost:
		s.addGroupMember(w, r, parts[1], parts[3], parts[5])
	case len(parts) == 6 && parts[0] == "accounts" && parts[2] == "groups" && parts[4] == "members" && r.Method == http.MethodDelete:
		s.removeGroupMember(w, r, parts[1], parts[3], parts[5])
	case len(parts) == 5 && parts[0] == "accounts" && parts[2] == "groups" && parts[4] == "assign-license" && r.Method == http.MethodPost:
		s.assignGroupLicense(w, r, parts[1], parts[3])
	case len(parts) == 4 && parts[0] == "accounts" && parts[2] == "reports" && r.Method == http.MethodGet:
		s.report(w, r, parts[1], parts[3])
	case len(parts) == 7 && parts[0] == "accounts" && parts[2] == "reports" && parts[3] == "onedrive" && parts[4] == "users" && parts[6] == "quota" && r.Method == http.MethodGet:
		s.oneDriveQuota(w, r, parts[1], parts[5])
	default:
		response.Error(w, http.StatusNotFound, "m365 route not implemented")
	}
}

func (s *Service) open(ctx context.Context) (*sql.DB, error) {
	db, err := s.store.Open(ctx)
	if err != nil {
		return nil, err
	}
	if err := ensureSchema(ctx, db); err != nil {
		db.Close()
		return nil, err
	}
	return db, nil
}

func ensureSchema(ctx context.Context, db *sql.DB) error {
	statements := []string{
		`CREATE TABLE IF NOT EXISTS m365_accounts (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			name TEXT NOT NULL,
			tenant_id TEXT NOT NULL,
			client_id TEXT NOT NULL,
			client_secret TEXT NOT NULL,
			description TEXT,
			default_domain TEXT,
			organization_name TEXT,
			enabled INTEGER DEFAULT 1,
			last_verified_at DATETIME,
			last_verified_error TEXT,
			created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
			updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
		)`,
		`CREATE UNIQUE INDEX IF NOT EXISTS idx_m365_accounts_tenant_client ON m365_accounts(tenant_id, client_id)`,
		`CREATE TABLE IF NOT EXISTS m365_report_cache (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			account_id INTEGER NOT NULL,
			report_type TEXT NOT NULL,
			report_key TEXT NOT NULL,
			summary_json TEXT NOT NULL,
			rows_json TEXT NOT NULL,
			cached_at DATETIME DEFAULT CURRENT_TIMESTAMP,
			FOREIGN KEY (account_id) REFERENCES m365_accounts(id) ON DELETE CASCADE
		)`,
		`CREATE UNIQUE INDEX IF NOT EXISTS idx_m365_report_cache_lookup ON m365_report_cache(account_id, report_type, report_key)`,
		`CREATE TABLE IF NOT EXISTS m365_sync_state (
			account_id INTEGER NOT NULL,
			resource_type TEXT NOT NULL,
			last_synced_at DATETIME,
			last_error TEXT,
			cursor_value TEXT,
			PRIMARY KEY (account_id, resource_type),
			FOREIGN KEY (account_id) REFERENCES m365_accounts(id) ON DELETE CASCADE
		)`,
	}
	for _, statement := range statements {
		if _, err := db.ExecContext(ctx, statement); err != nil {
			return fmt.Errorf("ensure m365 schema: %w", err)
		}
	}
	return nil
}

func (s *Service) accounts(w http.ResponseWriter, r *http.Request) {
	switch r.Method {
	case http.MethodGet:
		db, err := s.open(r.Context())
		if err != nil {
			response.Error(w, http.StatusInternalServerError, err.Error())
			return
		}
		defer db.Close()
		accounts, err := loadAccounts(r.Context(), db)
		if err != nil {
			response.Error(w, http.StatusInternalServerError, err.Error())
			return
		}
		items := make([]map[string]interface{}, 0, len(accounts))
		for _, account := range accounts {
			items = append(items, safeAccount(account))
		}
		response.OK(w, map[string]interface{}{"items": items})
	case http.MethodPost:
		payload, err := readObject(r)
		if err != nil {
			response.Error(w, http.StatusBadRequest, err.Error())
			return
		}
		record, err := payloadToAccount(payload, accountRecord{})
		if err != nil {
			response.Error(w, http.StatusBadRequest, err.Error())
			return
		}
		encryptedSecret, err := secure.SecureEncrypt(record.ClientSecret)
		if err != nil {
			response.Error(w, http.StatusInternalServerError, err.Error())
			return
		}
		db, err := s.open(r.Context())
		if err != nil {
			response.Error(w, http.StatusInternalServerError, err.Error())
			return
		}
		defer db.Close()
		result, err := db.ExecContext(
			r.Context(),
			`INSERT INTO m365_accounts (name, tenant_id, client_id, client_secret, description, default_domain, organization_name, enabled, updated_at)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)`,
			record.Name,
			record.TenantID,
			record.ClientID,
			encryptedSecret,
			record.Description,
			record.DefaultDomain,
			record.Organization,
			boolToInt(record.Enabled),
		)
		if err != nil {
			response.Error(w, http.StatusInternalServerError, err.Error())
			return
		}
		id, _ := result.LastInsertId()
		response.OK(w, map[string]interface{}{"id": id})
	default:
		response.Error(w, http.StatusMethodNotAllowed, "method not allowed")
	}
}

func (s *Service) accountMutation(w http.ResponseWriter, r *http.Request, idText string) {
	id, err := parseID(idText)
	if err != nil {
		response.Error(w, http.StatusBadRequest, "invalid account id")
		return
	}
	db, err := s.open(r.Context())
	if err != nil {
		response.Error(w, http.StatusInternalServerError, err.Error())
		return
	}
	defer db.Close()

	switch r.Method {
	case http.MethodDelete:
		if _, err := db.ExecContext(r.Context(), `DELETE FROM m365_accounts WHERE id = ?`, id); err != nil {
			response.Error(w, http.StatusInternalServerError, err.Error())
			return
		}
		response.OK(w, map[string]interface{}{"deleted": true})
	case http.MethodPut:
		existing, err := loadAccount(r.Context(), db, id)
		if err != nil {
			if errors.Is(err, errAccountNotFound) {
				response.Error(w, http.StatusNotFound, err.Error())
				return
			}
			response.Error(w, http.StatusInternalServerError, err.Error())
			return
		}
		payload, err := readObject(r)
		if err != nil {
			response.Error(w, http.StatusBadRequest, err.Error())
			return
		}
		record, err := payloadToAccount(payload, existing)
		if err != nil {
			response.Error(w, http.StatusBadRequest, err.Error())
			return
		}
		secretValue := existing.ClientSecret
		if incoming := strings.TrimSpace(stringValue(payload["clientSecret"], "")); incoming != "" {
			secretValue = incoming
		} else if !secure.IsEncrypted(secretValue) {
			secretValue = existing.ClientSecret
		}
		encryptedSecret, err := secure.SecureEncrypt(secretValue)
		if err != nil {
			response.Error(w, http.StatusInternalServerError, err.Error())
			return
		}
		_, err = db.ExecContext(
			r.Context(),
			`UPDATE m365_accounts
			 SET name = ?, tenant_id = ?, client_id = ?, client_secret = ?, description = ?, default_domain = ?, organization_name = ?, enabled = ?, updated_at = CURRENT_TIMESTAMP
			 WHERE id = ?`,
			record.Name,
			record.TenantID,
			record.ClientID,
			encryptedSecret,
			record.Description,
			record.DefaultDomain,
			record.Organization,
			boolToInt(record.Enabled),
			id,
		)
		if err != nil {
			response.Error(w, http.StatusInternalServerError, err.Error())
			return
		}
		response.OK(w, map[string]interface{}{"updated": true})
	default:
		response.Error(w, http.StatusMethodNotAllowed, "method not allowed")
	}
}

func (s *Service) verifyAccount(w http.ResponseWriter, r *http.Request, idText string) {
	account, err := s.loadDecryptedAccount(r.Context(), idText)
	if err != nil {
		s.writeAccountError(w, err)
		return
	}
	org, err := s.fetchOrganization(r.Context(), account)
	db, dbErr := s.open(r.Context())
	if dbErr == nil {
		defer db.Close()
		if err != nil {
			_, _ = db.ExecContext(r.Context(), `UPDATE m365_accounts SET last_verified_at = CURRENT_TIMESTAMP, last_verified_error = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`, err.Error(), account.ID)
		} else {
			_, _ = db.ExecContext(r.Context(), `UPDATE m365_accounts SET organization_name = ?, default_domain = ?, last_verified_at = CURRENT_TIMESTAMP, last_verified_error = '', updated_at = CURRENT_TIMESTAMP WHERE id = ?`, stringValue(org["displayName"], account.Organization), pickDefaultDomain(org), account.ID)
		}
	}
	if err != nil {
		response.Error(w, http.StatusBadGateway, err.Error())
		return
	}
	response.OK(w, map[string]interface{}{
		"organization": org,
		"permissionsHint": []string{
			"Reports.Read.All",
			"User.Read.All",
			"User.ReadWrite.All",
			"LicenseAssignment.Read.All",
			"LicenseAssignment.ReadWrite.All",
			"Group.Create",
			"GroupMember.ReadWrite.All",
		},
	})
}

func (s *Service) organization(w http.ResponseWriter, r *http.Request, idText string) {
	account, err := s.loadDecryptedAccount(r.Context(), idText)
	if err != nil {
		s.writeAccountError(w, err)
		return
	}
	org, err := s.fetchOrganization(r.Context(), account)
	if err != nil {
		response.Error(w, http.StatusBadGateway, err.Error())
		return
	}
	response.OK(w, org)
}

func (s *Service) users(w http.ResponseWriter, r *http.Request, idText string) {
	account, err := s.loadDecryptedAccount(r.Context(), idText)
	if err != nil {
		s.writeAccountError(w, err)
		return
	}
	switch r.Method {
	case http.MethodGet:
		query := url.Values{}
		query.Set("$top", clampPositive(r.URL.Query().Get("top"), 50, 200))
		query.Set("$count", "true")
		query.Set("$select", "id,displayName,userPrincipalName,mail,jobTitle,department,officeLocation,usageLocation,accountEnabled,createdDateTime")
		search := strings.TrimSpace(r.URL.Query().Get("search"))
		if search != "" {
			query.Set("$search", fmt.Sprintf(`"displayName:%s" OR "userPrincipalName:%s"`, escapeSearch(search), escapeSearch(search)))
		}
		path := "/users?" + query.Encode()
		headers := map[string]string{"ConsistencyLevel": "eventual"}
		result := map[string]interface{}{}
		if err := s.graphJSON(r.Context(), account, http.MethodGet, path, nil, headers, &result); err != nil {
			response.Error(w, http.StatusBadGateway, err.Error())
			return
		}
		response.OK(w, map[string]interface{}{
			"items":    objectArray(result["value"]),
			"count":    numberValue(result["@odata.count"]),
			"nextLink": stringValue(result["@odata.nextLink"], ""),
		})
	case http.MethodPost:
		payload, err := readObject(r)
		if err != nil {
			response.Error(w, http.StatusBadRequest, err.Error())
			return
		}
		body, err := normalizeCreateUserPayload(payload)
		if err != nil {
			response.Error(w, http.StatusBadRequest, err.Error())
			return
		}
		created := map[string]interface{}{}
		if err := s.graphJSON(r.Context(), account, http.MethodPost, "/users", body, nil, &created); err != nil {
			response.Error(w, http.StatusBadGateway, err.Error())
			return
		}
		response.OK(w, created)
	default:
		response.Error(w, http.StatusMethodNotAllowed, "method not allowed")
	}
}

func (s *Service) userDetails(w http.ResponseWriter, r *http.Request, idText, userID string) {
	account, err := s.loadDecryptedAccount(r.Context(), idText)
	if err != nil {
		s.writeAccountError(w, err)
		return
	}
	result := map[string]interface{}{}
	path := "/users/" + url.PathEscape(userID) + "?$select=id,displayName,userPrincipalName,mail,jobTitle,department,officeLocation,usageLocation,accountEnabled,createdDateTime,assignedLicenses,proxyAddresses,businessPhones"
	if err := s.graphJSON(r.Context(), account, http.MethodGet, path, nil, nil, &result); err != nil {
		response.Error(w, http.StatusBadGateway, err.Error())
		return
	}
	response.OK(w, result)
}

func (s *Service) userMutation(w http.ResponseWriter, r *http.Request, idText, userID string) {
	account, err := s.loadDecryptedAccount(r.Context(), idText)
	if err != nil {
		s.writeAccountError(w, err)
		return
	}
	switch r.Method {
	case http.MethodPatch:
		payload, err := readObject(r)
		if err != nil {
			response.Error(w, http.StatusBadRequest, err.Error())
			return
		}
		body := map[string]interface{}{}
		for _, key := range []string{"displayName", "jobTitle", "department", "officeLocation", "usageLocation", "mailNickname"} {
			if value, ok := payload[key]; ok {
				body[key] = value
			}
		}
		if value, ok := payload["accountEnabled"]; ok {
			body["accountEnabled"] = boolValue(value, true)
		}
		if len(body) == 0 {
			response.Error(w, http.StatusBadRequest, "no supported fields provided")
			return
		}
		if err := s.graphJSON(r.Context(), account, http.MethodPatch, "/users/"+url.PathEscape(userID), body, nil, nil); err != nil {
			response.Error(w, http.StatusBadGateway, err.Error())
			return
		}
		response.OK(w, map[string]interface{}{"updated": true})
	case http.MethodDelete:
		if err := s.graphJSON(r.Context(), account, http.MethodDelete, "/users/"+url.PathEscape(userID), nil, nil, nil); err != nil {
			response.Error(w, http.StatusBadGateway, err.Error())
			return
		}
		response.OK(w, map[string]interface{}{"deleted": true})
	default:
		response.Error(w, http.StatusMethodNotAllowed, "method not allowed")
	}
}

func (s *Service) userLicenseDetails(w http.ResponseWriter, r *http.Request, idText, userID string) {
	account, err := s.loadDecryptedAccount(r.Context(), idText)
	if err != nil {
		s.writeAccountError(w, err)
		return
	}
	result := map[string]interface{}{}
	if err := s.graphJSON(r.Context(), account, http.MethodGet, "/users/"+url.PathEscape(userID)+"/licenseDetails", nil, nil, &result); err != nil {
		response.Error(w, http.StatusBadGateway, err.Error())
		return
	}
	response.OK(w, map[string]interface{}{"items": objectArray(result["value"])})
}

func (s *Service) assignUserLicense(w http.ResponseWriter, r *http.Request, idText, userID string) {
	account, err := s.loadDecryptedAccount(r.Context(), idText)
	if err != nil {
		s.writeAccountError(w, err)
		return
	}
	payload, err := readObject(r)
	if err != nil {
		response.Error(w, http.StatusBadRequest, err.Error())
		return
	}
	body := map[string]interface{}{
		"addLicenses":    normalizeLicenseAssignments(payload["addLicenses"]),
		"removeLicenses": stringArray(payload["removeLicenses"]),
	}
	result := map[string]interface{}{}
	if err := s.graphJSON(r.Context(), account, http.MethodPost, "/users/"+url.PathEscape(userID)+"/assignLicense", body, nil, &result); err != nil {
		response.Error(w, http.StatusBadGateway, err.Error())
		return
	}
	response.OK(w, result)
}

func (s *Service) listSKUs(w http.ResponseWriter, r *http.Request, idText string) {
	account, err := s.loadDecryptedAccount(r.Context(), idText)
	if err != nil {
		s.writeAccountError(w, err)
		return
	}
	result := map[string]interface{}{}
	if err := s.graphJSON(r.Context(), account, http.MethodGet, "/subscribedSkus", nil, nil, &result); err != nil {
		response.Error(w, http.StatusBadGateway, err.Error())
		return
	}
	response.OK(w, map[string]interface{}{"items": objectArray(result["value"])})
}

func (s *Service) groups(w http.ResponseWriter, r *http.Request, idText string) {
	account, err := s.loadDecryptedAccount(r.Context(), idText)
	if err != nil {
		s.writeAccountError(w, err)
		return
	}
	switch r.Method {
	case http.MethodGet:
		result := map[string]interface{}{}
		query := url.Values{}
		query.Set("$top", clampPositive(r.URL.Query().Get("top"), 50, 200))
		query.Set("$select", "id,displayName,mail,mailEnabled,securityEnabled,createdDateTime")
		search := strings.TrimSpace(r.URL.Query().Get("search"))
		if search != "" {
			query.Set("$search", fmt.Sprintf(`"displayName:%s"`, escapeSearch(search)))
		}
		headers := map[string]string{"ConsistencyLevel": "eventual"}
		if err := s.graphJSON(r.Context(), account, http.MethodGet, "/groups?"+query.Encode(), nil, headers, &result); err != nil {
			response.Error(w, http.StatusBadGateway, err.Error())
			return
		}
		response.OK(w, map[string]interface{}{"items": objectArray(result["value"])})
	case http.MethodPost:
		payload, err := readObject(r)
		if err != nil {
			response.Error(w, http.StatusBadRequest, err.Error())
			return
		}
		name := strings.TrimSpace(stringValue(payload["displayName"], ""))
		mailNickname := strings.TrimSpace(stringValue(payload["mailNickname"], ""))
		if name == "" || mailNickname == "" {
			response.Error(w, http.StatusBadRequest, "displayName and mailNickname are required")
			return
		}
		body := map[string]interface{}{
			"displayName":     name,
			"mailEnabled":     boolValue(payload["mailEnabled"], false),
			"mailNickname":    mailNickname,
			"securityEnabled": boolValue(payload["securityEnabled"], true),
		}
		created := map[string]interface{}{}
		if err := s.graphJSON(r.Context(), account, http.MethodPost, "/groups", body, nil, &created); err != nil {
			response.Error(w, http.StatusBadGateway, err.Error())
			return
		}
		response.OK(w, created)
	default:
		response.Error(w, http.StatusMethodNotAllowed, "method not allowed")
	}
}

func (s *Service) groupMembers(w http.ResponseWriter, r *http.Request, idText, groupID string) {
	account, err := s.loadDecryptedAccount(r.Context(), idText)
	if err != nil {
		s.writeAccountError(w, err)
		return
	}
	result := map[string]interface{}{}
	path := "/groups/" + url.PathEscape(groupID) + "/members?$top=100&$select=id,displayName,userPrincipalName,mail"
	if err := s.graphJSON(r.Context(), account, http.MethodGet, path, nil, nil, &result); err != nil {
		response.Error(w, http.StatusBadGateway, err.Error())
		return
	}
	response.OK(w, map[string]interface{}{"items": objectArray(result["value"])})
}

func (s *Service) addGroupMember(w http.ResponseWriter, r *http.Request, idText, groupID, memberID string) {
	account, err := s.loadDecryptedAccount(r.Context(), idText)
	if err != nil {
		s.writeAccountError(w, err)
		return
	}
	body := map[string]interface{}{
		"@odata.id": strings.TrimRight(s.graphBase, "/") + "/directoryObjects/" + url.PathEscape(memberID),
	}
	if err := s.graphJSON(r.Context(), account, http.MethodPost, "/groups/"+url.PathEscape(groupID)+"/members/$ref", body, nil, nil); err != nil {
		response.Error(w, http.StatusBadGateway, err.Error())
		return
	}
	response.OK(w, map[string]interface{}{"added": true})
}

func (s *Service) removeGroupMember(w http.ResponseWriter, r *http.Request, idText, groupID, memberID string) {
	account, err := s.loadDecryptedAccount(r.Context(), idText)
	if err != nil {
		s.writeAccountError(w, err)
		return
	}
	if err := s.graphJSON(r.Context(), account, http.MethodDelete, "/groups/"+url.PathEscape(groupID)+"/members/"+url.PathEscape(memberID)+"/$ref", nil, nil, nil); err != nil {
		response.Error(w, http.StatusBadGateway, err.Error())
		return
	}
	response.OK(w, map[string]interface{}{"removed": true})
}

func (s *Service) assignGroupLicense(w http.ResponseWriter, r *http.Request, idText, groupID string) {
	account, err := s.loadDecryptedAccount(r.Context(), idText)
	if err != nil {
		s.writeAccountError(w, err)
		return
	}
	payload, err := readObject(r)
	if err != nil {
		response.Error(w, http.StatusBadRequest, err.Error())
		return
	}
	body := map[string]interface{}{
		"addLicenses":    normalizeLicenseAssignments(payload["addLicenses"]),
		"removeLicenses": stringArray(payload["removeLicenses"]),
	}
	result := map[string]interface{}{}
	if err := s.graphJSON(r.Context(), account, http.MethodPost, "/groups/"+url.PathEscape(groupID)+"/assignLicense", body, nil, &result); err != nil {
		response.Error(w, http.StatusBadGateway, err.Error())
		return
	}
	response.OK(w, result)
}

func (s *Service) report(w http.ResponseWriter, r *http.Request, idText, reportType string) {
	account, err := s.loadDecryptedAccount(r.Context(), idText)
	if err != nil {
		s.writeAccountError(w, err)
		return
	}
	graphMethod, ok := reportTypeMap[reportType]
	if !ok {
		response.Error(w, http.StatusBadRequest, "unsupported report type")
		return
	}
	reportKey := strings.TrimSpace(r.URL.Query().Get("period"))
	if reportKey == "" {
		reportKey = "D7"
	}
	refresh := r.URL.Query().Get("refresh") == "1"
	if !refresh {
		if cached, err := s.loadCachedReport(r.Context(), account.ID, reportType, reportKey); err == nil {
			response.OK(w, cached)
			return
		}
	}
	summary, rows, err := s.fetchReport(r.Context(), account, graphMethod, reportKey)
	if err != nil {
		response.Error(w, http.StatusBadGateway, err.Error())
		return
	}
	if err := s.saveCachedReport(r.Context(), account.ID, reportType, reportKey, summary, rows); err != nil {
		response.Error(w, http.StatusInternalServerError, err.Error())
		return
	}
	response.OK(w, reportCacheRecord{
		Summary:  summary,
		Rows:     rows,
		CachedAt: time.Now().UTC().Format(time.RFC3339),
	})
}

func (s *Service) oneDriveQuota(w http.ResponseWriter, r *http.Request, idText, userID string) {
	account, err := s.loadDecryptedAccount(r.Context(), idText)
	if err != nil {
		s.writeAccountError(w, err)
		return
	}
	result := map[string]interface{}{}
	if err := s.graphJSON(r.Context(), account, http.MethodGet, "/users/"+url.PathEscape(userID)+"/drive?$select=id,quota", nil, nil, &result); err != nil {
		response.Error(w, http.StatusBadGateway, err.Error())
		return
	}
	quota := objectValue(result["quota"])
	total := numberValue(quota["total"])
	used := numberValue(quota["used"])
	remaining := numberValue(quota["remaining"])
	usageRate := 0.0
	if total > 0 {
		usageRate = float64(used) / float64(total)
	}
	response.OK(w, map[string]interface{}{
		"id":         stringValue(result["id"], ""),
		"quota":      quota,
		"total":      total,
		"used":       used,
		"remaining":  remaining,
		"usageRate":  usageRate,
		"usagePct":   usageRate * 100,
	})
}

func (s *Service) loadDecryptedAccount(ctx context.Context, idText string) (accountRecord, error) {
	id, err := parseID(idText)
	if err != nil {
		return accountRecord{}, fmt.Errorf("invalid account id")
	}
	db, err := s.open(ctx)
	if err != nil {
		return accountRecord{}, err
	}
	defer db.Close()
	account, err := loadAccount(ctx, db, id)
	if err != nil {
		return accountRecord{}, err
	}
	account.ClientSecret = secure.SecureDecrypt(account.ClientSecret)
	return account, nil
}

func (s *Service) fetchOrganization(ctx context.Context, account accountRecord) (map[string]interface{}, error) {
	result := map[string]interface{}{}
	if err := s.graphJSON(ctx, account, http.MethodGet, "/organization", nil, nil, &result); err != nil {
		return nil, err
	}
	items := objectArray(result["value"])
	if len(items) == 0 {
		return map[string]interface{}{}, nil
	}
	return items[0], nil
}

func (s *Service) loadCachedReport(ctx context.Context, accountID int64, reportType, reportKey string) (reportCacheRecord, error) {
	db, err := s.open(ctx)
	if err != nil {
		return reportCacheRecord{}, err
	}
	defer db.Close()
	row := db.QueryRowContext(ctx, `SELECT summary_json, rows_json, cached_at FROM m365_report_cache WHERE account_id = ? AND report_type = ? AND report_key = ?`, accountID, reportType, reportKey)
	var summaryJSON, rowsJSON, cachedAt string
	if err := row.Scan(&summaryJSON, &rowsJSON, &cachedAt); err != nil {
		return reportCacheRecord{}, err
	}
	record := reportCacheRecord{CachedAt: cachedAt}
	if err := json.Unmarshal([]byte(summaryJSON), &record.Summary); err != nil {
		return reportCacheRecord{}, err
	}
	if err := json.Unmarshal([]byte(rowsJSON), &record.Rows); err != nil {
		return reportCacheRecord{}, err
	}
	return record, nil
}

func (s *Service) saveCachedReport(ctx context.Context, accountID int64, reportType, reportKey string, summary map[string]interface{}, rows []map[string]string) error {
	db, err := s.open(ctx)
	if err != nil {
		return err
	}
	defer db.Close()
	summaryJSON, err := json.Marshal(summary)
	if err != nil {
		return err
	}
	rowsJSON, err := json.Marshal(rows)
	if err != nil {
		return err
	}
	_, err = db.ExecContext(
		ctx,
		`INSERT INTO m365_report_cache (account_id, report_type, report_key, summary_json, rows_json, cached_at)
		 VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
		 ON CONFLICT(account_id, report_type, report_key)
		 DO UPDATE SET summary_json = excluded.summary_json, rows_json = excluded.rows_json, cached_at = CURRENT_TIMESTAMP`,
		accountID,
		reportType,
		reportKey,
		string(summaryJSON),
		string(rowsJSON),
	)
	return err
}

func (s *Service) fetchReport(ctx context.Context, account accountRecord, graphMethod, reportKey string) (map[string]interface{}, []map[string]string, error) {
	location, err := s.fetchReportLocation(ctx, account, graphMethod, reportKey)
	if err != nil {
		return nil, nil, err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, location, nil)
	if err != nil {
		return nil, nil, err
	}
	resp, err := s.client.Do(req)
	if err != nil {
		return nil, nil, err
	}
	defer resp.Body.Close()
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return nil, nil, fmt.Errorf("report download failed: %s", resp.Status)
	}
	reader := csv.NewReader(resp.Body)
	reader.FieldsPerRecord = -1
	rows, err := reader.ReadAll()
	if err != nil {
		return nil, nil, err
	}
	if len(rows) == 0 {
		return map[string]interface{}{"period": reportKey, "count": 0}, []map[string]string{}, nil
	}
	headers := rows[0]
	items := make([]map[string]string, 0, maxInt(len(rows)-1, 0))
	for _, row := range rows[1:] {
		item := map[string]string{}
		for i, header := range headers {
			if i < len(row) {
				item[header] = row[i]
			} else {
				item[header] = ""
			}
		}
		items = append(items, item)
	}
	summary := map[string]interface{}{
		"period":        reportKey,
		"count":         len(items),
		"columns":       headers,
		"downloadedAt":  time.Now().UTC().Format(time.RFC3339),
	}
	return summary, items, nil
}

func (s *Service) fetchReportLocation(ctx context.Context, account accountRecord, graphMethod, reportKey string) (string, error) {
	token, err := s.token(ctx, account)
	if err != nil {
		return "", err
	}
	url := strings.TrimRight(s.graphBase, "/") + "/reports/" + graphMethod + "(period='" + reportKey + "')"
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return "", err
	}
	req.Header.Set("Authorization", "Bearer "+token)
	redirectClient := *s.client
	redirectClient.CheckRedirect = func(req *http.Request, via []*http.Request) error {
		return http.ErrUseLastResponse
	}
	resp, err := redirectClient.Do(req)
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()
	if resp.StatusCode == http.StatusFound {
		return resp.Header.Get("Location"), nil
	}
	body, _ := io.ReadAll(resp.Body)
	return "", fmt.Errorf("report redirect failed: %s %s", resp.Status, strings.TrimSpace(string(body)))
}

func (s *Service) graphJSON(ctx context.Context, account accountRecord, method, path string, body interface{}, extraHeaders map[string]string, target interface{}) error {
	token, err := s.token(ctx, account)
	if err != nil {
		return err
	}
	var bodyReader io.Reader
	if body != nil {
		raw, err := json.Marshal(body)
		if err != nil {
			return err
		}
		bodyReader = strings.NewReader(string(raw))
	}
	req, err := http.NewRequestWithContext(ctx, method, joinURL(s.graphBase, path), bodyReader)
	if err != nil {
		return err
	}
	req.Header.Set("Authorization", "Bearer "+token)
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	for key, value := range extraHeaders {
		req.Header.Set(key, value)
	}
	resp, err := s.client.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return decodeGraphError(resp)
	}
	if target == nil || resp.StatusCode == http.StatusNoContent {
		return nil
	}
	return json.NewDecoder(resp.Body).Decode(target)
}

func (s *Service) token(ctx context.Context, account accountRecord) (string, error) {
	form := url.Values{}
	form.Set("client_id", account.ClientID)
	form.Set("client_secret", account.ClientSecret)
	form.Set("scope", "https://graph.microsoft.com/.default")
	form.Set("grant_type", "client_credentials")
	endpoint := strings.TrimRight(s.loginBase, "/") + "/" + account.TenantID + "/oauth2/v2.0/token"
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, endpoint, strings.NewReader(form.Encode()))
	if err != nil {
		return "", err
	}
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	resp, err := s.client.Do(req)
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return "", decodeGraphError(resp)
	}
	var payload struct {
		AccessToken string `json:"access_token"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&payload); err != nil {
		return "", err
	}
	if payload.AccessToken == "" {
		return "", errors.New("empty access token")
	}
	return payload.AccessToken, nil
}

func loadAccounts(ctx context.Context, db *sql.DB) ([]accountRecord, error) {
	rows, err := db.QueryContext(ctx, `SELECT id, name, tenant_id, client_id, client_secret, description, default_domain, organization_name, enabled, COALESCE(last_verified_at, ''), COALESCE(last_verified_error, ''), created_at, updated_at FROM m365_accounts ORDER BY created_at DESC`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	accounts := []accountRecord{}
	for rows.Next() {
		record, err := scanAccount(rows)
		if err != nil {
			return nil, err
		}
		accounts = append(accounts, record)
	}
	return accounts, rows.Err()
}

func loadAccount(ctx context.Context, db *sql.DB, id int64) (accountRecord, error) {
	row := db.QueryRowContext(ctx, `SELECT id, name, tenant_id, client_id, client_secret, description, default_domain, organization_name, enabled, COALESCE(last_verified_at, ''), COALESCE(last_verified_error, ''), created_at, updated_at FROM m365_accounts WHERE id = ?`, id)
	record, err := scanAccount(row)
	if err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return accountRecord{}, errAccountNotFound
		}
		return accountRecord{}, err
	}
	return record, nil
}

type rowScanner interface {
	Scan(dest ...interface{}) error
}

func scanAccount(scanner rowScanner) (accountRecord, error) {
	record := accountRecord{}
	var enabled int
	if err := scanner.Scan(
		&record.ID,
		&record.Name,
		&record.TenantID,
		&record.ClientID,
		&record.ClientSecret,
		&record.Description,
		&record.DefaultDomain,
		&record.Organization,
		&enabled,
		&record.LastVerifiedAt,
		&record.LastVerifiedErr,
		&record.CreatedAt,
		&record.UpdatedAt,
	); err != nil {
		return accountRecord{}, err
	}
	record.Enabled = enabled != 0
	return record, nil
}

func safeAccount(record accountRecord) map[string]interface{} {
	secretMask := maskSecret(record.ClientSecret)
	return map[string]interface{}{
		"id":              record.ID,
		"name":            record.Name,
		"tenantId":        record.TenantID,
		"clientId":        record.ClientID,
		"clientSecret":    secretMask,
		"description":     record.Description,
		"defaultDomain":   record.DefaultDomain,
		"organization":    record.Organization,
		"enabled":         record.Enabled,
		"lastVerifiedAt":  emptyToNil(record.LastVerifiedAt),
		"lastVerifiedErr": emptyToNil(record.LastVerifiedErr),
		"createdAt":       record.CreatedAt,
		"updatedAt":       record.UpdatedAt,
	}
}

func payloadToAccount(payload map[string]interface{}, base accountRecord) (accountRecord, error) {
	record := base
	record.Name = strings.TrimSpace(stringValue(payload["name"], record.Name))
	record.TenantID = strings.TrimSpace(stringValue(payload["tenantId"], stringValue(payload["tenant_id"], record.TenantID)))
	record.ClientID = strings.TrimSpace(stringValue(payload["clientId"], stringValue(payload["client_id"], record.ClientID)))
	record.ClientSecret = strings.TrimSpace(stringValue(payload["clientSecret"], stringValue(payload["client_secret"], record.ClientSecret)))
	record.Description = strings.TrimSpace(stringValue(payload["description"], record.Description))
	record.DefaultDomain = strings.TrimSpace(stringValue(payload["defaultDomain"], stringValue(payload["default_domain"], record.DefaultDomain)))
	record.Organization = strings.TrimSpace(stringValue(payload["organization"], stringValue(payload["organizationName"], record.Organization)))
	record.Enabled = boolValue(payload["enabled"], true)
	if record.Name == "" || record.TenantID == "" || record.ClientID == "" || record.ClientSecret == "" {
		return accountRecord{}, errors.New("name, tenantId, clientId and clientSecret are required")
	}
	return record, nil
}

func normalizeCreateUserPayload(payload map[string]interface{}) (map[string]interface{}, error) {
	displayName := strings.TrimSpace(stringValue(payload["displayName"], ""))
	mailNickname := strings.TrimSpace(stringValue(payload["mailNickname"], ""))
	userPrincipalName := strings.TrimSpace(stringValue(payload["userPrincipalName"], ""))
	password := strings.TrimSpace(stringValue(payload["password"], ""))
	if displayName == "" || mailNickname == "" || userPrincipalName == "" || password == "" {
		return nil, errors.New("displayName, mailNickname, userPrincipalName and password are required")
	}
	body := map[string]interface{}{
		"accountEnabled":    boolValue(payload["accountEnabled"], true),
		"displayName":       displayName,
		"mailNickname":      mailNickname,
		"userPrincipalName": userPrincipalName,
		"passwordProfile": map[string]interface{}{
			"password":                       password,
			"forceChangePasswordNextSignIn": boolValue(payload["forceChangePasswordNextSignIn"], true),
		},
	}
	for _, key := range []string{"department", "jobTitle", "officeLocation", "usageLocation"} {
		if value := strings.TrimSpace(stringValue(payload[key], "")); value != "" {
			body[key] = value
		}
	}
	return body, nil
}

func normalizeLicenseAssignments(value interface{}) []map[string]interface{} {
	items := []map[string]interface{}{}
	for _, raw := range interfaceArray(value) {
		item := objectValue(raw)
		skuID := strings.TrimSpace(stringValue(item["skuId"], ""))
		if skuID == "" {
			continue
		}
		items = append(items, map[string]interface{}{
			"skuId":         skuID,
			"disabledPlans": stringArray(item["disabledPlans"]),
		})
	}
	return items
}

func decodeGraphError(resp *http.Response) error {
	body, _ := io.ReadAll(resp.Body)
	var envelope graphErrorEnvelope
	if err := json.Unmarshal(body, &envelope); err == nil && envelope.Error.Message != "" {
		return fmt.Errorf("%s: %s", envelope.Error.Code, envelope.Error.Message)
	}
	message := strings.TrimSpace(string(body))
	if message == "" {
		message = resp.Status
	}
	return fmt.Errorf("graph request failed: %s", message)
}

func joinURL(base, path string) string {
	if strings.HasPrefix(path, "http://") || strings.HasPrefix(path, "https://") {
		return path
	}
	return strings.TrimRight(base, "/") + "/" + strings.TrimLeft(path, "/")
}

func envURL(name, fallback string) string {
	value := strings.TrimSpace(os.Getenv(name))
	if value == "" {
		return fallback
	}
	return strings.TrimRight(value, "/")
}

func parseID(text string) (int64, error) {
	return strconv.ParseInt(strings.TrimSpace(text), 10, 64)
}

func readObject(r *http.Request) (map[string]interface{}, error) {
	defer r.Body.Close()
	payload := map[string]interface{}{}
	if err := json.NewDecoder(r.Body).Decode(&payload); err != nil {
		return nil, err
	}
	return payload, nil
}

func stringValue(value interface{}, fallback string) string {
	if value == nil {
		return fallback
	}
	switch typed := value.(type) {
	case string:
		if typed == "" {
			return fallback
		}
		return typed
	case json.Number:
		return typed.String()
	default:
		text := strings.TrimSpace(fmt.Sprint(value))
		if text == "" || text == "<nil>" {
			return fallback
		}
		return text
	}
}

func objectValue(value interface{}) map[string]interface{} {
	if typed, ok := value.(map[string]interface{}); ok && typed != nil {
		return typed
	}
	return map[string]interface{}{}
}

func objectArray(value interface{}) []map[string]interface{} {
	list := []map[string]interface{}{}
	for _, item := range interfaceArray(value) {
		list = append(list, objectValue(item))
	}
	return list
}

func interfaceArray(value interface{}) []interface{} {
	if value == nil {
		return []interface{}{}
	}
	if typed, ok := value.([]interface{}); ok {
		return typed
	}
	return []interface{}{}
}

func stringArray(value interface{}) []string {
	result := []string{}
	for _, item := range interfaceArray(value) {
		text := strings.TrimSpace(stringValue(item, ""))
		if text != "" {
			result = append(result, text)
		}
	}
	return result
}

func numberValue(value interface{}) int64 {
	switch typed := value.(type) {
	case int:
		return int64(typed)
	case int64:
		return typed
	case float64:
		return int64(typed)
	case json.Number:
		parsed, _ := typed.Int64()
		return parsed
	case string:
		parsed, _ := strconv.ParseInt(strings.TrimSpace(typed), 10, 64)
		return parsed
	default:
		return 0
	}
}

func boolValue(value interface{}, fallback bool) bool {
	if value == nil {
		return fallback
	}
	switch typed := value.(type) {
	case bool:
		return typed
	case string:
		switch strings.ToLower(strings.TrimSpace(typed)) {
		case "true", "1", "yes", "on":
			return true
		case "false", "0", "no", "off":
			return false
		default:
			return fallback
		}
	case float64:
		return typed != 0
	default:
		return fallback
	}
}

func boolToInt(value bool) int {
	if value {
		return 1
	}
	return 0
}

func pickDefaultDomain(org map[string]interface{}) string {
	for _, item := range interfaceArray(org["verifiedDomains"]) {
		domain := objectValue(item)
		if boolValue(domain["isDefault"], false) {
			return stringValue(domain["name"], "")
		}
	}
	for _, item := range interfaceArray(org["verifiedDomains"]) {
		domain := objectValue(item)
		if name := stringValue(domain["name"], ""); name != "" {
			return name
		}
	}
	return ""
}

func maskSecret(secret string) string {
	plain := secure.SecureDecrypt(secret)
	if plain == "" {
		return ""
	}
	if len(plain) <= 8 {
		return strings.Repeat("*", len(plain))
	}
	return plain[:4] + strings.Repeat("*", 8) + plain[len(plain)-4:]
}

func emptyToNil(value string) interface{} {
	if strings.TrimSpace(value) == "" {
		return nil
	}
	return value
}

func clampPositive(raw string, fallback, max int) string {
	value, err := strconv.Atoi(strings.TrimSpace(raw))
	if err != nil || value <= 0 {
		value = fallback
	}
	if value > max {
		value = max
	}
	return strconv.Itoa(value)
}

func escapeSearch(value string) string {
	replacer := strings.NewReplacer(`"`, `\"`)
	return replacer.Replace(value)
}

func maxInt(a, b int) int {
	if a > b {
		return a
	}
	return b
}

func (s *Service) writeAccountError(w http.ResponseWriter, err error) {
	switch {
	case errors.Is(err, errAccountNotFound):
		response.Error(w, http.StatusNotFound, err.Error())
	default:
		response.Error(w, http.StatusBadRequest, err.Error())
	}
}
