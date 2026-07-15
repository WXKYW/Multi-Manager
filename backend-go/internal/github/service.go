package github

import (
	"context"
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/iwvw/api-monitor/backend-go/internal/config"
	"github.com/iwvw/api-monitor/backend-go/internal/database"
	"github.com/iwvw/api-monitor/backend-go/internal/response"
	"github.com/iwvw/api-monitor/backend-go/internal/secure"
)

type Service struct {
	cfg      config.Config
	store    *database.Store
	client   *apiClient
	notifier Notifier

	stop       chan struct{}
	stopped    chan struct{}
	statusMu   sync.Mutex
	status     CollectorStatus
	streamMu   sync.Mutex
	streamNext int64
	streams    map[int64]chan map[string]interface{}
}

func New(cfg config.Config) *Service {
	s := &Service{
		cfg:     cfg,
		store:   database.New(cfg),
		client:  newAPIClient(),
		stop:    make(chan struct{}),
		stopped: make(chan struct{}),
		streams: map[int64]chan map[string]interface{}{},
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if db, err := s.open(ctx); err == nil {
		db.Close()
	}
	go s.collectorLoop()
	return s
}

func (s *Service) SetNotifier(notifier Notifier) {
	s.notifier = notifier
}

func (s *Service) Stop() {
	select {
	case <-s.stopped:
		return
	default:
	}
	close(s.stop)
	<-s.stopped
}

func (s *Service) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	path := strings.TrimPrefix(r.URL.Path, "/api/github")
	path = strings.Trim(path, "/")
	parts := []string{}
	if path != "" {
		parts = strings.Split(path, "/")
	}

	switch {
	case path == "" && r.Method == http.MethodGet:
		s.overview(w, r)
	case len(parts) == 1 && parts[0] == "tokens":
		s.tokens(w, r)
	case len(parts) == 2 && parts[0] == "tokens":
		s.tokenByID(w, r, parts[1])
	case len(parts) == 3 && parts[0] == "tokens" && parts[2] == "test" && r.Method == http.MethodPost:
		s.testToken(w, r, parts[1])
	case len(parts) == 3 && parts[0] == "tokens" && parts[2] == "rotate" && r.Method == http.MethodPost:
		s.rotateToken(w, r, parts[1])
	case len(parts) == 1 && parts[0] == "repositories":
		s.repositories(w, r)
	case len(parts) == 2 && parts[0] == "repositories" && parts[1] == "parse-url" && r.Method == http.MethodPost:
		s.parseURL(w, r)
	case len(parts) == 2 && parts[0] == "repositories":
		s.repositoryByID(w, r, parts[1])
	case len(parts) == 3 && parts[0] == "repositories" && parts[2] == "refresh" && r.Method == http.MethodPost:
		s.refreshRepository(w, r, parts[1])
	case len(parts) == 3 && parts[0] == "repositories" && parts[2] == "summary" && r.Method == http.MethodGet:
		s.repositorySummary(w, r, parts[1])
	case len(parts) == 3 && parts[0] == "repositories" && parts[2] == "trends" && r.Method == http.MethodGet:
		s.repositoryTrends(w, r, parts[1])
	case len(parts) == 4 && parts[0] == "repositories" && parts[2] == "actions" && parts[3] == "runs" && r.Method == http.MethodGet:
		s.repositoryActionRuns(w, r, parts[1])
	case len(parts) == 4 && parts[0] == "repositories" && parts[2] == "actions" && parts[3] == "workflows" && r.Method == http.MethodGet:
		s.repositoryWorkflows(w, r, parts[1])
	case len(parts) == 3 && parts[0] == "repositories" && parts[2] == "branches" && r.Method == http.MethodGet:
		s.repositoryBranches(w, r, parts[1])
	case len(parts) == 4 && parts[0] == "repositories" && parts[2] == "webhook" && parts[3] == "configure" && r.Method == http.MethodPost:
		s.configureRepositoryWebhook(w, r, parts[1])
	case len(parts) == 3 && parts[0] == "repositories" && parts[2] == "traffic" && r.Method == http.MethodGet:
		s.repositoryTraffic(w, r, parts[1])
	case len(parts) == 3 && parts[0] == "repositories" && parts[2] == "contributors" && r.Method == http.MethodGet:
		s.repositoryContributors(w, r, parts[1])
	case len(parts) == 3 && parts[0] == "repositories" && parts[2] == "events" && r.Method == http.MethodGet:
		s.repositoryEvents(w, r, parts[1])
	case len(parts) == 6 && parts[0] == "repositories" && parts[2] == "actions" && parts[3] == "runs" && parts[5] == "rerun" && r.Method == http.MethodPost:
		s.workflowRunOperation(w, r, parts[1], parts[4], "rerun")
	case len(parts) == 6 && parts[0] == "repositories" && parts[2] == "actions" && parts[3] == "runs" && parts[5] == "rerun-failed-jobs" && r.Method == http.MethodPost:
		s.workflowRunOperation(w, r, parts[1], parts[4], "rerun-failed-jobs")
	case len(parts) == 6 && parts[0] == "repositories" && parts[2] == "actions" && parts[3] == "runs" && parts[5] == "cancel" && r.Method == http.MethodPost:
		s.workflowRunOperation(w, r, parts[1], parts[4], "cancel")
	case len(parts) == 6 && parts[0] == "repositories" && parts[2] == "actions" && parts[3] == "workflows" && parts[5] == "dispatch" && r.Method == http.MethodPost:
		s.workflowDispatch(w, r, parts[1], parts[4])
	case len(parts) == 1 && parts[0] == "settings":
		s.settings(w, r)
	case len(parts) == 2 && parts[0] == "collector" && parts[1] == "run" && r.Method == http.MethodPost:
		s.runCollector(w, r)
	case len(parts) == 2 && parts[0] == "collector" && parts[1] == "status" && r.Method == http.MethodGet:
		s.collectorStatus(w, r)
	case len(parts) == 1 && parts[0] == "history" && r.Method == http.MethodDelete:
		s.deleteHistory(w, r)
	case len(parts) == 1 && parts[0] == "events" && r.Method == http.MethodGet:
		s.events(w, r)
	case len(parts) == 2 && parts[0] == "events" && parts[1] == "stream" && r.Method == http.MethodGet:
		s.eventStream(w, r)
	case len(parts) >= 1 && parts[0] == "webhook":
		s.webhook(w, r, parts)
	default:
		response.Error(w, http.StatusNotFound, "github route not implemented")
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

func (s *Service) overview(w http.ResponseWriter, r *http.Request) {
	db, err := s.open(r.Context())
	if err != nil {
		response.Error(w, http.StatusInternalServerError, err.Error())
		return
	}
	defer db.Close()
	repos, _ := listRepositories(r.Context(), db, false)
	attachLatestActionTiming(r.Context(), db, repos)
	defaultTokenAvailable := false
	defaultTokenLogin := ""
	if token, ok, tokenErr := getDefaultToken(r.Context(), db); tokenErr == nil && ok {
		defaultTokenAvailable = token.Enabled && token.TokenEncrypted != ""
		defaultTokenLogin = token.AccountLogin
	}
	for i := range repos {
		repos[i].Authenticated = defaultTokenAvailable
		repos[i].OwnedByToken = defaultTokenLogin != "" && strings.EqualFold(defaultTokenLogin, repos[i].Owner)
		if repos[i].TokenID != nil {
			if token, ok, tokenErr := getToken(r.Context(), db, *repos[i].TokenID); tokenErr == nil && ok {
				repos[i].Authenticated = token.Enabled && token.TokenEncrypted != ""
				repos[i].OwnedByToken = token.AccountLogin != "" && strings.EqualFold(token.AccountLogin, repos[i].Owner)
			} else {
				repos[i].Authenticated = false
				repos[i].OwnedByToken = false
			}
		}
	}
	settings, _ := loadSettings(r.Context(), db)
	response.OK(w, map[string]interface{}{"repositories": repos, "settings": settings, "collector": s.currentStatus()})
}

func (s *Service) tokens(w http.ResponseWriter, r *http.Request) {
	switch r.Method {
	case http.MethodGet:
		db, err := s.open(r.Context())
		if err != nil {
			response.Error(w, http.StatusInternalServerError, err.Error())
			return
		}
		defer db.Close()
		tokens, err := listTokens(r.Context(), db)
		if err != nil {
			response.Error(w, http.StatusInternalServerError, err.Error())
			return
		}
		response.OK(w, safeTokens(tokens))
	case http.MethodPost:
		payload, err := readObject(r)
		if err != nil {
			response.Error(w, http.StatusBadRequest, err.Error())
			return
		}
		name := strings.TrimSpace(stringValue(payload, "name", ""))
		rawToken := strings.TrimSpace(stringValue(payload, "token", ""))
		if name == "" || rawToken == "" {
			response.Error(w, http.StatusBadRequest, "名称和 Token 不能为空")
			return
		}
		encrypted, err := secure.SecureEncrypt(rawToken)
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
		tx, err := db.BeginTx(r.Context(), nil)
		if err != nil {
			response.Error(w, http.StatusInternalServerError, err.Error())
			return
		}
		defer tx.Rollback()
		if boolValue(payload["default_token"], false) {
			_, _ = tx.ExecContext(r.Context(), `UPDATE github_tokens SET default_token = 0`)
		}
		res, err := tx.ExecContext(r.Context(), `INSERT INTO github_tokens (name, type, token_encrypted, enabled, default_token, note)
			VALUES (?, ?, ?, ?, ?, ?)`, name, firstNonEmpty(stringValue(payload, "type", ""), "fine_grained"), encrypted, boolInt(boolValue(payload["enabled"], true)), boolInt(boolValue(payload["default_token"], false)), stringValue(payload, "note", ""))
		if err != nil {
			response.Error(w, http.StatusInternalServerError, err.Error())
			return
		}
		if err := tx.Commit(); err != nil {
			response.Error(w, http.StatusInternalServerError, err.Error())
			return
		}
		id, _ := res.LastInsertId()
		token, _, _ := getToken(r.Context(), db, id)
		response.OK(w, safeToken(token))
	default:
		response.Error(w, http.StatusMethodNotAllowed, "method not allowed")
	}
}

func (s *Service) tokenByID(w http.ResponseWriter, r *http.Request, idText string) {
	id, err := parseID(idText)
	if err != nil {
		response.Error(w, http.StatusBadRequest, "invalid token id")
		return
	}
	db, err := s.open(r.Context())
	if err != nil {
		response.Error(w, http.StatusInternalServerError, err.Error())
		return
	}
	defer db.Close()
	switch r.Method {
	case http.MethodPut, http.MethodPatch:
		payload, err := readObject(r)
		if err != nil {
			response.Error(w, http.StatusBadRequest, err.Error())
			return
		}
		sets := []string{"updated_at = CURRENT_TIMESTAMP"}
		args := []interface{}{}
		if v := strings.TrimSpace(stringValue(payload, "name", "")); v != "" {
			sets = append(sets, "name = ?")
			args = append(args, v)
		}
		if v, ok := payload["enabled"]; ok {
			sets = append(sets, "enabled = ?")
			args = append(args, boolInt(boolValue(v, true)))
		}
		if v, ok := payload["default_token"]; ok {
			def := boolValue(v, false)
			if def {
				_, _ = db.ExecContext(r.Context(), `UPDATE github_tokens SET default_token = 0`)
			}
			sets = append(sets, "default_token = ?")
			args = append(args, boolInt(def))
		}
		if v := strings.TrimSpace(stringValue(payload, "token", "")); v != "" {
			encrypted, err := secure.SecureEncrypt(v)
			if err != nil {
				response.Error(w, http.StatusInternalServerError, err.Error())
				return
			}
			sets = append(sets, "token_encrypted = ?")
			args = append(args, encrypted)
		}
		if _, ok := payload["note"]; ok {
			sets = append(sets, "note = ?")
			args = append(args, stringValue(payload, "note", ""))
		}
		args = append(args, id)
		if _, err := db.ExecContext(r.Context(), `UPDATE github_tokens SET `+strings.Join(sets, ", ")+` WHERE id = ?`, args...); err != nil {
			response.Error(w, http.StatusInternalServerError, err.Error())
			return
		}
		token, _, _ := getToken(r.Context(), db, id)
		response.OK(w, safeToken(token))
	case http.MethodDelete:
		if _, err := db.ExecContext(r.Context(), `DELETE FROM github_tokens WHERE id = ?`, id); err != nil {
			response.Error(w, http.StatusInternalServerError, err.Error())
			return
		}
		response.OK(w, map[string]interface{}{"deleted": true})
	default:
		response.Error(w, http.StatusMethodNotAllowed, "method not allowed")
	}
}

func (s *Service) testToken(w http.ResponseWriter, r *http.Request, idText string) {
	token, db, ok := s.tokenForRequest(w, r, idText)
	if !ok {
		return
	}
	defer db.Close()
	plain := secure.SecureDecrypt(token.TokenEncrypted)
	var repo *Repository
	if repoID := int64Query(r, "repositoryId", 0); repoID > 0 {
		if found, exists, repoErr := getRepository(r.Context(), db, repoID); repoErr == nil && exists {
			repo = &found
		}
	}
	result, rate, err := s.client.testToken(r.Context(), plain, repo)
	status := "success"
	errMsg := ""
	if err != nil {
		status = "failed"
		errMsg = err.Error()
	}
	permissions := jsonString(map[string]interface{}{})
	accountLogin := ""
	if result != nil {
		permissions = jsonString(result["permissions"])
		if user, exists := result["user"].(map[string]interface{}); exists {
			accountLogin = strings.TrimSpace(asString(user["login"]))
		}
		if permissionMap, exists := result["permissions"].(map[string]interface{}); exists {
			if checks, exists := permissionMap["checks"].([]map[string]interface{}); exists {
				for _, check := range checks {
					if check["status"] == "failed" {
						status = "warning"
						break
					}
				}
			}
		}
	}
	if err == nil && repo != nil {
		if remote, _, repoErr := s.client.fetchRepository(r.Context(), plain, repo.Owner, repo.Name); repoErr == nil {
			ownedByToken := accountLogin != "" && strings.EqualFold(accountLogin, remote.Owner.Login)
			canOperateActions := remote.Permissions.Admin || remote.Permissions.Maintain || remote.Permissions.Push
			if strings.EqualFold(strings.TrimSpace(r.URL.Query().Get("bind")), "true") {
				_, _ = db.ExecContext(r.Context(), `UPDATE github_repositories SET token_id = ?, owned_by_token = ?, can_operate_actions = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
					token.ID, boolInt(ownedByToken), boolInt(canOperateActions), repo.ID)
			} else {
				_, _ = db.ExecContext(r.Context(), `UPDATE github_repositories SET owned_by_token = ?, can_operate_actions = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
					boolInt(ownedByToken), boolInt(canOperateActions), repo.ID)
			}
		}
	}
	_, _ = db.ExecContext(r.Context(), `UPDATE github_tokens SET last_test_status = ?, last_test_error = ?, last_test_at = CURRENT_TIMESTAMP,
		account_login = ?, scopes = ?, permissions_json = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`, status, errMsg, accountLogin, rate.OAuthScopes, permissions, token.ID)
	if err != nil {
		response.Error(w, http.StatusBadGateway, err.Error())
		return
	}
	response.OK(w, result)
}

func (s *Service) rotateToken(w http.ResponseWriter, r *http.Request, idText string) {
	s.tokenByID(w, r, idText)
}

func (s *Service) repositories(w http.ResponseWriter, r *http.Request) {
	switch r.Method {
	case http.MethodGet:
		db, err := s.open(r.Context())
		if err != nil {
			response.Error(w, http.StatusInternalServerError, err.Error())
			return
		}
		defer db.Close()
		repos, err := listRepositories(r.Context(), db, false)
		if err != nil {
			response.Error(w, http.StatusInternalServerError, err.Error())
			return
		}
		response.OK(w, repos)
	case http.MethodPost:
		s.createRepository(w, r)
	default:
		response.Error(w, http.StatusMethodNotAllowed, "method not allowed")
	}
}

func (s *Service) createRepository(w http.ResponseWriter, r *http.Request) {
	payload, err := readObject(r)
	if err != nil {
		response.Error(w, http.StatusBadRequest, err.Error())
		return
	}
	owner, repo := parseRepoInput(firstNonEmpty(stringValue(payload, "url", ""), stringValue(payload, "repository", ""), stringValue(payload, "full_name", "")))
	if owner == "" || repo == "" {
		owner = strings.TrimSpace(stringValue(payload, "owner", ""))
		repo = strings.TrimSpace(stringValue(payload, "name", ""))
	}
	if owner == "" || repo == "" {
		response.Error(w, http.StatusBadRequest, "请输入 GitHub 仓库 URL 或 owner/repo")
		return
	}
	db, err := s.open(r.Context())
	if err != nil {
		response.Error(w, http.StatusInternalServerError, err.Error())
		return
	}
	defer db.Close()
	settings, _ := loadSettings(r.Context(), db)
	var tokenID *int64
	if v, ok := payload["token_id"]; ok {
		if id := int64Value(v, 0); id > 0 {
			tokenID = &id
		}
	}
	plainToken := ""
	tokenAccountLogin := ""
	if tokenID != nil {
		token, ok, err := getToken(r.Context(), db, *tokenID)
		if err != nil || !ok {
			response.Error(w, http.StatusBadRequest, "GitHub Token 不存在")
			return
		}
		plainToken = secure.SecureDecrypt(token.TokenEncrypted)
		tokenAccountLogin = token.AccountLogin
	} else if token, ok, _ := getDefaultToken(r.Context(), db); ok {
		id := token.ID
		tokenID = &id
		plainToken = secure.SecureDecrypt(token.TokenEncrypted)
		tokenAccountLogin = token.AccountLogin
	}
	ghRepo, rate, err := s.client.fetchRepository(r.Context(), plainToken, owner, repo)
	if err != nil {
		response.Error(w, http.StatusBadGateway, err.Error())
		return
	}
	secret := ""
	if settings.AutoCreateWebhookSecret {
		secret = randomSecret()
	}
	fullName := firstNonEmpty(ghRepo.FullName, owner+"/"+repo)
	ownedByToken := tokenAccountLogin != "" && strings.EqualFold(tokenAccountLogin, ghRepo.Owner.Login)
	canOperateActions := ghRepo.Permissions.Admin || ghRepo.Permissions.Maintain || ghRepo.Permissions.Push
	res, err := db.ExecContext(r.Context(), `INSERT INTO github_repositories (
		token_id, owner, name, full_name, html_url, description, private, owned_by_token, can_operate_actions, default_branch, language,
		tags, note, enabled, notify_enabled, webhook_enabled, webhook_secret, collect_interval_seconds, retention_days,
		last_status, stars, forks, watchers, open_issues, rate_limit_remaining, rate_limit_reset
	) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?, ?, ?)`,
		nullableInt64(tokenID), owner, repo, fullName, ghRepo.HTMLURL, ghRepo.Description, boolInt(ghRepo.Private), boolInt(ownedByToken), boolInt(canOperateActions), ghRepo.DefaultBranch, ghRepo.Language,
		parseTags(payload["tags"]), stringValue(payload, "note", ""), boolInt(boolValue(payload["enabled"], true)), boolInt(boolValue(payload["notify_enabled"], true)),
		boolInt(boolValue(payload["webhook_enabled"], false)), secret, intValue(payload, "collect_interval_seconds", settings.DefaultCollectInterval),
		intValue(payload, "retention_days", settings.DefaultRetentionDays), ghRepo.StargazersCount, ghRepo.ForksCount, ghRepo.WatchersCount, ghRepo.OpenIssuesCount,
		rate.Remaining, timeOrNil(rate.Reset))
	if err != nil {
		response.Error(w, http.StatusInternalServerError, err.Error())
		return
	}
	id, _ := res.LastInsertId()
	go s.refreshRepositoryByID(context.Background(), id, "create")
	repository, _, _ := getRepository(r.Context(), db, id)
	response.OK(w, repository)
}

func (s *Service) repositoryByID(w http.ResponseWriter, r *http.Request, idText string) {
	id, err := parseID(idText)
	if err != nil {
		response.Error(w, http.StatusBadRequest, "invalid repository id")
		return
	}
	db, err := s.open(r.Context())
	if err != nil {
		response.Error(w, http.StatusInternalServerError, err.Error())
		return
	}
	defer db.Close()
	switch r.Method {
	case http.MethodGet:
		repo, ok, err := getRepository(r.Context(), db, id)
		if err != nil {
			response.Error(w, http.StatusInternalServerError, err.Error())
			return
		}
		if !ok {
			response.Error(w, http.StatusNotFound, "仓库不存在")
			return
		}
		response.OK(w, repo)
	case http.MethodPut, http.MethodPatch:
		payload, err := readObject(r)
		if err != nil {
			response.Error(w, http.StatusBadRequest, err.Error())
			return
		}
		updates := []string{"updated_at = CURRENT_TIMESTAMP"}
		args := []interface{}{}
		for key, column := range map[string]string{"note": "note", "tags": "tags", "description": "description"} {
			if _, ok := payload[key]; ok {
				updates = append(updates, column+" = ?")
				if key == "tags" {
					args = append(args, parseTags(payload[key]))
				} else {
					args = append(args, stringValue(payload, key, ""))
				}
			}
		}
		for key, column := range map[string]string{"enabled": "enabled", "notify_enabled": "notify_enabled", "webhook_enabled": "webhook_enabled"} {
			if v, ok := payload[key]; ok {
				updates = append(updates, column+" = ?")
				args = append(args, boolInt(boolValue(v, true)))
			}
		}
		for key, column := range map[string]string{"collect_interval_seconds": "collect_interval_seconds", "retention_days": "retention_days", "token_id": "token_id"} {
			if v, ok := payload[key]; ok {
				updates = append(updates, column+" = ?")
				if key == "token_id" {
					args = append(args, nullableInt64(int64Value(v, 0)))
					updates = append(updates, "owned_by_token = ?", "can_operate_actions = ?")
					args = append(args, 0, 0)
				} else {
					args = append(args, int64Value(v, 0))
				}
			}
		}
		args = append(args, id)
		if _, err := db.ExecContext(r.Context(), `UPDATE github_repositories SET `+strings.Join(updates, ", ")+` WHERE id = ?`, args...); err != nil {
			response.Error(w, http.StatusInternalServerError, err.Error())
			return
		}
		repo, _, _ := getRepository(r.Context(), db, id)
		response.OK(w, repo)
	case http.MethodDelete:
		clean := strings.EqualFold(r.URL.Query().Get("clean"), "true")
		if clean {
			for _, table := range []string{"github_repository_snapshots", "github_action_runs", "github_traffic_samples", "github_contributors", "github_events", "github_operation_audit"} {
				_, _ = db.ExecContext(r.Context(), `DELETE FROM `+table+` WHERE repository_id = ?`, id)
			}
		}
		if _, err := db.ExecContext(r.Context(), `DELETE FROM github_repositories WHERE id = ?`, id); err != nil {
			response.Error(w, http.StatusInternalServerError, err.Error())
			return
		}
		response.OK(w, map[string]interface{}{"deleted": true, "history_cleaned": clean})
	default:
		response.Error(w, http.StatusMethodNotAllowed, "method not allowed")
	}
}

func (s *Service) parseURL(w http.ResponseWriter, r *http.Request) {
	payload, err := readObject(r)
	if err != nil {
		response.Error(w, http.StatusBadRequest, err.Error())
		return
	}
	owner, repo := parseRepoInput(firstNonEmpty(stringValue(payload, "url", ""), stringValue(payload, "repository", "")))
	if owner == "" || repo == "" {
		response.Error(w, http.StatusBadRequest, "无法解析 GitHub 仓库地址")
		return
	}
	response.OK(w, map[string]interface{}{"owner": owner, "repo": repo, "full_name": owner + "/" + repo, "html_url": "https://github.com/" + owner + "/" + repo})
}

func (s *Service) refreshRepository(w http.ResponseWriter, r *http.Request, idText string) {
	id, err := parseID(idText)
	if err != nil {
		response.Error(w, http.StatusBadRequest, "invalid repository id")
		return
	}
	if err := s.refreshRepositoryByID(r.Context(), id, "manual"); err != nil {
		response.Error(w, http.StatusBadGateway, err.Error())
		return
	}
	db, err := s.open(r.Context())
	if err != nil {
		response.Error(w, http.StatusInternalServerError, err.Error())
		return
	}
	defer db.Close()
	repo, _, _ := getRepository(r.Context(), db, id)
	response.OK(w, repo)
}

func (s *Service) repositorySummary(w http.ResponseWriter, r *http.Request, idText string) {
	id, _ := parseID(idText)
	db, err := s.open(r.Context())
	if err != nil {
		response.Error(w, http.StatusInternalServerError, err.Error())
		return
	}
	defer db.Close()
	repo, ok, err := getRepository(r.Context(), db, id)
	if err != nil || !ok {
		response.Error(w, http.StatusNotFound, "仓库不存在")
		return
	}
	events, _ := listEvents(r.Context(), db, id, 20)
	response.OK(w, map[string]interface{}{"repository": repo, "events": events})
}

func (s *Service) repositoryTrends(w http.ResponseWriter, r *http.Request, idText string) {
	id, _ := parseID(idText)
	days := clamp(intQuery(r, "days", 30), 1, 3650)
	db, err := s.open(r.Context())
	if err != nil {
		response.Error(w, http.StatusInternalServerError, err.Error())
		return
	}
	defer db.Close()
	cutoff := time.Now().AddDate(0, 0, -days).UTC().Format(time.RFC3339)
	rows, err := db.QueryContext(r.Context(), `SELECT id, repository_id, stars, forks, watchers, open_issues, open_pull_requests,
		commit_count, release_count, contributor_count, actions_total, actions_success, actions_failed,
		traffic_views, traffic_uniques, traffic_clones, traffic_clone_uniques, collected_at
		FROM github_repository_snapshots WHERE repository_id = ? AND collected_at >= ? ORDER BY collected_at ASC`, id, cutoff)
	if err != nil {
		response.Error(w, http.StatusInternalServerError, err.Error())
		return
	}
	defer rows.Close()
	var snapshots []Snapshot
	for rows.Next() {
		var snap Snapshot
		if err := rows.Scan(&snap.ID, &snap.RepositoryID, &snap.Stars, &snap.Forks, &snap.Watchers, &snap.OpenIssues, &snap.OpenPullRequests,
			&snap.CommitCount, &snap.ReleaseCount, &snap.ContributorCount, &snap.ActionsTotal, &snap.ActionsSuccess, &snap.ActionsFailed,
			&snap.TrafficViews, &snap.TrafficUniques, &snap.TrafficClones, &snap.TrafficCloneUniques, &snap.CollectedAt); err != nil {
			response.Error(w, http.StatusInternalServerError, err.Error())
			return
		}
		snapshots = append(snapshots, snap)
	}
	response.OK(w, map[string]interface{}{"days": days, "snapshots": snapshots})
}

func (s *Service) repositoryActionRuns(w http.ResponseWriter, r *http.Request, idText string) {
	id, _ := parseID(idText)
	limit := clamp(intQuery(r, "limit", 50), 1, 200)
	db, err := s.open(r.Context())
	if err != nil {
		response.Error(w, http.StatusInternalServerError, err.Error())
		return
	}
	defer db.Close()
	rows, err := db.QueryContext(r.Context(), `SELECT run_id, workflow_name, display_title, status, conclusion, event, branch, commit_sha, commit_message, actor, html_url,
		run_started_at, created_at, updated_at, collected_at FROM github_action_runs WHERE repository_id = ? ORDER BY COALESCE(created_at, collected_at) DESC LIMIT ?`, id, limit)
	if err != nil {
		response.Error(w, http.StatusInternalServerError, err.Error())
		return
	}
	defer rows.Close()
	var runs []map[string]interface{}
	for rows.Next() {
		var runID int64
		var workflow, title, status, conclusion, event, branch, sha, commitMessage, actor, htmlURL string
		var started, created, updated, collected sql.NullString
		if err := rows.Scan(&runID, &workflow, &title, &status, &conclusion, &event, &branch, &sha, &commitMessage, &actor, &htmlURL, &started, &created, &updated, &collected); err != nil {
			response.Error(w, http.StatusInternalServerError, err.Error())
			return
		}
		runs = append(runs, map[string]interface{}{"run_id": runID, "workflow_name": workflow, "display_title": title, "status": status, "conclusion": conclusion, "event": event, "branch": branch, "commit_sha": sha, "commit_message": commitMessage, "actor": actor, "html_url": htmlURL, "run_started_at": nullString(started), "created_at": nullString(created), "updated_at": nullString(updated), "collected_at": nullString(collected)})
	}
	response.OK(w, runs)
}

func (s *Service) repositoryWorkflows(w http.ResponseWriter, r *http.Request, idText string) {
	repo, token, db, ok := s.repoAndTokenForRequest(w, r, idText)
	if !ok {
		return
	}
	defer db.Close()
	workflows, _, err := s.client.fetchWorkflows(r.Context(), token, repo.Owner, repo.Name)
	if err != nil {
		response.Error(w, http.StatusBadGateway, err.Error())
		return
	}
	response.OK(w, workflows.Workflows)
}

func (s *Service) repositoryBranches(w http.ResponseWriter, r *http.Request, idText string) {
	repo, token, db, ok := s.repoAndTokenForRequest(w, r, idText)
	if !ok {
		return
	}
	defer db.Close()
	branches, _, err := s.client.fetchBranches(r.Context(), token, repo.Owner, repo.Name)
	if err != nil {
		response.Error(w, http.StatusBadGateway, err.Error())
		return
	}
	response.OK(w, branches)
}

func (s *Service) configureRepositoryWebhook(w http.ResponseWriter, r *http.Request, idText string) {
	repo, token, db, ok := s.repoAndTokenForRequest(w, r, idText)
	if !ok {
		return
	}
	defer db.Close()
	payload, err := readObject(r)
	if err != nil {
		response.Error(w, http.StatusBadRequest, err.Error())
		return
	}
	payloadURL := strings.TrimSpace(stringValue(payload, "payload_url", ""))
	parsedURL, err := url.Parse(payloadURL)
	if err != nil || parsedURL.Scheme != "https" || parsedURL.Host == "" || strings.EqualFold(parsedURL.Hostname(), "localhost") || parsedURL.Hostname() == "127.0.0.1" || parsedURL.Hostname() == "::1" {
		response.Error(w, http.StatusBadRequest, "Webhook Payload URL 必须是可供 GitHub 访问的公网 HTTPS 地址")
		return
	}
	secret := repo.WebhookSecret
	if secret == "" {
		secret = randomSecret()
		if _, err := db.ExecContext(r.Context(), `UPDATE github_repositories SET webhook_secret = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`, secret, repo.ID); err != nil {
			response.Error(w, http.StatusInternalServerError, err.Error())
			return
		}
	}
	hookID, created, _, err := s.client.configureWebhook(r.Context(), token, repo.Owner, repo.Name, payloadURL, secret)
	s.auditOperation(r.Context(), db, repo.ID, "webhook_configure", payloadURL, payload, map[string]interface{}{"hook_id": hookID, "created": created}, err)
	if err != nil {
		response.Error(w, http.StatusBadGateway, err.Error())
		return
	}
	if _, err := db.ExecContext(r.Context(), `UPDATE github_repositories SET webhook_enabled = 1, updated_at = CURRENT_TIMESTAMP WHERE id = ?`, repo.ID); err != nil {
		response.Error(w, http.StatusInternalServerError, err.Error())
		return
	}
	response.OK(w, map[string]interface{}{"hook_id": hookID, "created": created, "payload_url": payloadURL})
}

func (s *Service) repositoryTraffic(w http.ResponseWriter, r *http.Request, idText string) {
	s.queryTable(w, r, idText, `SELECT views, view_uniques, clones, clone_uniques, collected_at FROM github_traffic_samples WHERE repository_id = ? ORDER BY collected_at DESC LIMIT ?`, []string{"views", "view_uniques", "clones", "clone_uniques", "collected_at"})
}

func (s *Service) repositoryContributors(w http.ResponseWriter, r *http.Request, idText string) {
	s.queryTable(w, r, idText, `SELECT login, avatar_url, html_url, contributions, collected_at FROM github_contributors WHERE repository_id = ? ORDER BY contributions DESC LIMIT ?`, []string{"login", "avatar_url", "html_url", "contributions", "collected_at"})
}

func (s *Service) repositoryEvents(w http.ResponseWriter, r *http.Request, idText string) {
	id, _ := parseID(idText)
	db, err := s.open(r.Context())
	if err != nil {
		response.Error(w, http.StatusInternalServerError, err.Error())
		return
	}
	defer db.Close()
	events, err := listEvents(r.Context(), db, id, intQuery(r, "limit", 100))
	if err != nil {
		response.Error(w, http.StatusInternalServerError, err.Error())
		return
	}
	response.OK(w, events)
}

func (s *Service) queryTable(w http.ResponseWriter, r *http.Request, idText, query string, columns []string) {
	id, _ := parseID(idText)
	db, err := s.open(r.Context())
	if err != nil {
		response.Error(w, http.StatusInternalServerError, err.Error())
		return
	}
	defer db.Close()
	rows, err := db.QueryContext(r.Context(), query, id, clamp(intQuery(r, "limit", 100), 1, 500))
	if err != nil {
		response.Error(w, http.StatusInternalServerError, err.Error())
		return
	}
	defer rows.Close()
	var result []map[string]interface{}
	for rows.Next() {
		values := make([]interface{}, len(columns))
		ptrs := make([]interface{}, len(columns))
		for i := range values {
			ptrs[i] = &values[i]
		}
		if err := rows.Scan(ptrs...); err != nil {
			response.Error(w, http.StatusInternalServerError, err.Error())
			return
		}
		item := map[string]interface{}{}
		for i, column := range columns {
			item[column] = normalizeDBValue(values[i])
		}
		result = append(result, item)
	}
	response.OK(w, result)
}

func (s *Service) settings(w http.ResponseWriter, r *http.Request) {
	db, err := s.open(r.Context())
	if err != nil {
		response.Error(w, http.StatusInternalServerError, err.Error())
		return
	}
	defer db.Close()
	switch r.Method {
	case http.MethodGet:
		settings, err := loadSettings(r.Context(), db)
		if err != nil {
			response.Error(w, http.StatusInternalServerError, err.Error())
			return
		}
		response.OK(w, settings)
	case http.MethodPut, http.MethodPatch:
		payload, err := readObject(r)
		if err != nil {
			response.Error(w, http.StatusBadRequest, err.Error())
			return
		}
		settings, err := updateSettings(r.Context(), db, payload)
		if err != nil {
			response.Error(w, http.StatusInternalServerError, err.Error())
			return
		}
		response.OK(w, settings)
	default:
		response.Error(w, http.StatusMethodNotAllowed, "method not allowed")
	}
}

func (s *Service) runCollector(w http.ResponseWriter, r *http.Request) {
	if err := s.collectOnce(r.Context()); err != nil {
		response.Error(w, http.StatusInternalServerError, err.Error())
		return
	}
	response.OK(w, s.currentStatus())
}

func (s *Service) collectorStatus(w http.ResponseWriter, r *http.Request) {
	response.OK(w, s.currentStatus())
}

func (s *Service) deleteHistory(w http.ResponseWriter, r *http.Request) {
	db, err := s.open(r.Context())
	if err != nil {
		response.Error(w, http.StatusInternalServerError, err.Error())
		return
	}
	defer db.Close()
	repoID := int64Query(r, "repositoryId", 0)
	days := intQuery(r, "days", 90)
	result, err := cleanupHistory(r.Context(), db, repoID, days)
	if err != nil {
		response.Error(w, http.StatusInternalServerError, err.Error())
		return
	}
	response.OK(w, result)
}

func (s *Service) events(w http.ResponseWriter, r *http.Request) {
	db, err := s.open(r.Context())
	if err != nil {
		response.Error(w, http.StatusInternalServerError, err.Error())
		return
	}
	defer db.Close()
	events, err := listEvents(r.Context(), db, int64Query(r, "repositoryId", 0), intQuery(r, "limit", 100))
	if err != nil {
		response.Error(w, http.StatusInternalServerError, err.Error())
		return
	}
	response.OK(w, events)
}

func (s *Service) eventStream(w http.ResponseWriter, r *http.Request) {
	flusher, ok := w.(http.Flusher)
	if !ok {
		response.Error(w, http.StatusInternalServerError, "streaming unsupported")
		return
	}
	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-cache")
	w.Header().Set("Connection", "keep-alive")
	ch, cancel := s.subscribe()
	defer cancel()
	fmt.Fprintf(w, "event: hello\ndata: %s\n\n", jsonString(map[string]interface{}{"connected": true}))
	flusher.Flush()
	for {
		select {
		case <-r.Context().Done():
			return
		case event := <-ch:
			fmt.Fprintf(w, "event: github\ndata: %s\n\n", jsonString(event))
			flusher.Flush()
		}
	}
}

func (s *Service) workflowRunOperation(w http.ResponseWriter, r *http.Request, idText, runText, operation string) {
	repo, token, db, ok := s.repoAndTokenForRequest(w, r, idText)
	if !ok {
		return
	}
	defer db.Close()
	runID, err := strconv.ParseInt(runText, 10, 64)
	if err != nil {
		response.Error(w, http.StatusBadRequest, "invalid run id")
		return
	}
	var opErr error
	if operation == "cancel" {
		_, opErr = s.client.cancelWorkflowRun(r.Context(), token, repo.Owner, repo.Name, runID)
	} else {
		_, opErr = s.client.rerunWorkflowRun(r.Context(), token, repo.Owner, repo.Name, runID, operation == "rerun-failed-jobs")
	}
	s.auditOperation(r.Context(), db, repo.ID, operation, runText, map[string]interface{}{}, map[string]interface{}{"ok": opErr == nil}, opErr)
	if opErr != nil {
		status := http.StatusBadGateway
		if actionPermissionDenied(opErr) {
			_, _ = db.ExecContext(r.Context(), `UPDATE github_repositories SET can_operate_actions = 0, updated_at = CURRENT_TIMESTAMP WHERE id = ?`, repo.ID)
			status = http.StatusForbidden
		}
		response.Error(w, status, opErr.Error())
		return
	}
	response.OK(w, map[string]interface{}{"operation": operation, "run_id": runID, "status": "submitted"})
}

func (s *Service) workflowDispatch(w http.ResponseWriter, r *http.Request, idText, workflowID string) {
	repo, token, db, ok := s.repoAndTokenForRequest(w, r, idText)
	if !ok {
		return
	}
	defer db.Close()
	payload, _ := readObject(r)
	ref := firstNonEmpty(stringValue(payload, "ref", ""), repo.DefaultBranch)
	inputs := objectValue(payload["inputs"])
	_, err := s.client.dispatchWorkflow(r.Context(), token, repo.Owner, repo.Name, workflowID, ref, inputs)
	s.auditOperation(r.Context(), db, repo.ID, "workflow_dispatch", workflowID, payload, map[string]interface{}{"ref": ref}, err)
	if err != nil {
		status := http.StatusBadGateway
		if actionPermissionDenied(err) {
			_, _ = db.ExecContext(r.Context(), `UPDATE github_repositories SET can_operate_actions = 0, updated_at = CURRENT_TIMESTAMP WHERE id = ?`, repo.ID)
			status = http.StatusForbidden
		}
		response.Error(w, status, err.Error())
		return
	}
	response.OK(w, map[string]interface{}{"workflow_id": workflowID, "ref": ref, "status": "submitted"})
}

func actionPermissionDenied(err error) bool {
	if err == nil {
		return false
	}
	message := strings.ToLower(err.Error())
	return strings.Contains(message, "resource not accessible by personal access token") ||
		strings.Contains(message, "must have actions: write") ||
		strings.Contains(message, "requires actions: write")
}

func (s *Service) webhook(w http.ResponseWriter, r *http.Request, parts []string) {
	if r.Method != http.MethodPost {
		response.Error(w, http.StatusMethodNotAllowed, "method not allowed")
		return
	}
	repoID := int64(0)
	if len(parts) >= 2 {
		repoID, _ = parseID(parts[1])
	}
	raw, err := io.ReadAll(io.LimitReader(r.Body, 10<<20))
	if err != nil {
		response.Error(w, http.StatusBadRequest, err.Error())
		return
	}
	db, err := s.open(r.Context())
	if err != nil {
		response.Error(w, http.StatusInternalServerError, err.Error())
		return
	}
	defer db.Close()
	var repo Repository
	ok := false
	if repoID > 0 {
		repo, ok, err = getRepository(r.Context(), db, repoID)
		if err != nil || !ok {
			response.Error(w, http.StatusNotFound, "仓库不存在")
			return
		}
	} else {
		var payload map[string]interface{}
		_ = json.Unmarshal(raw, &payload)
		fullName := stringValue(objectValue(payload["repository"]), "full_name", "")
		repo, ok, err = getRepositoryByFullName(r.Context(), db, fullName)
		if err != nil || !ok {
			response.Error(w, http.StatusNotFound, "仓库不存在")
			return
		}
		repoID = repo.ID
	}
	delivery := r.Header.Get("X-GitHub-Delivery")
	eventType := r.Header.Get("X-GitHub-Event")
	valid := verifySignature(raw, repo.WebhookSecret, r.Header.Get("X-Hub-Signature-256"))
	duplicate := false
	if delivery != "" {
		var count int
		_ = db.QueryRowContext(r.Context(), `SELECT COUNT(*) FROM github_webhook_deliveries WHERE delivery_id = ?`, delivery).Scan(&count)
		duplicate = count > 0
	}
	_, _ = db.ExecContext(r.Context(), `INSERT OR IGNORE INTO github_webhook_deliveries (repository_id, delivery_id, event_type, signature_valid, duplicate, payload_json)
		VALUES (?, ?, ?, ?, ?, ?)`, repoID, delivery, eventType, boolInt(valid), boolInt(duplicate), string(raw))
	if !valid {
		response.Error(w, http.StatusUnauthorized, "GitHub webhook signature invalid")
		return
	}
	if duplicate {
		response.OK(w, map[string]interface{}{"duplicate": true})
		return
	}
	var payload map[string]interface{}
	_ = json.Unmarshal(raw, &payload)
	s.handleWebhookEvent(r.Context(), db, repo, eventType, payload)
	response.OK(w, map[string]interface{}{"received": true, "event": eventType})
}

func (s *Service) tokenForRequest(w http.ResponseWriter, r *http.Request, idText string) (Token, *sql.DB, bool) {
	id, err := parseID(idText)
	if err != nil {
		response.Error(w, http.StatusBadRequest, "invalid token id")
		return Token{}, nil, false
	}
	db, err := s.open(r.Context())
	if err != nil {
		response.Error(w, http.StatusInternalServerError, err.Error())
		return Token{}, nil, false
	}
	token, ok, err := getToken(r.Context(), db, id)
	if err != nil {
		db.Close()
		response.Error(w, http.StatusInternalServerError, err.Error())
		return Token{}, nil, false
	}
	if !ok {
		db.Close()
		response.Error(w, http.StatusNotFound, "GitHub Token 不存在")
		return Token{}, nil, false
	}
	return token, db, true
}

func (s *Service) repoAndTokenForRequest(w http.ResponseWriter, r *http.Request, idText string) (Repository, string, *sql.DB, bool) {
	id, err := parseID(idText)
	if err != nil {
		response.Error(w, http.StatusBadRequest, "invalid repository id")
		return Repository{}, "", nil, false
	}
	db, err := s.open(r.Context())
	if err != nil {
		response.Error(w, http.StatusInternalServerError, err.Error())
		return Repository{}, "", nil, false
	}
	repo, ok, err := getRepository(r.Context(), db, id)
	if err != nil || !ok {
		db.Close()
		response.Error(w, http.StatusNotFound, "仓库不存在")
		return Repository{}, "", nil, false
	}
	token, err := s.tokenForRepository(r.Context(), db, repo)
	if err != nil {
		db.Close()
		response.Error(w, http.StatusBadRequest, err.Error())
		return Repository{}, "", nil, false
	}
	return repo, token, db, true
}

func (s *Service) tokenForRepository(ctx context.Context, db *sql.DB, repo Repository) (string, error) {
	if repo.TokenID != nil {
		token, ok, err := getToken(ctx, db, *repo.TokenID)
		if err != nil {
			return "", err
		}
		if !ok || !token.Enabled {
			return "", errors.New("仓库绑定的 GitHub Token 不可用")
		}
		return secure.SecureDecrypt(token.TokenEncrypted), nil
	}
	if token, ok, err := getDefaultToken(ctx, db); err != nil {
		return "", err
	} else if ok {
		return secure.SecureDecrypt(token.TokenEncrypted), nil
	}
	if repo.Private {
		return "", errors.New("私有仓库需要 GitHub Token")
	}
	return "", nil
}

func (s *Service) tokenAccountLoginForRepository(ctx context.Context, db *sql.DB, repo Repository) string {
	if repo.TokenID != nil {
		if token, ok, err := getToken(ctx, db, *repo.TokenID); err == nil && ok && token.Enabled {
			return token.AccountLogin
		}
		return ""
	}
	if token, ok, err := getDefaultToken(ctx, db); err == nil && ok && token.Enabled {
		return token.AccountLogin
	}
	return ""
}

func (s *Service) auditOperation(ctx context.Context, db *sql.DB, repoID int64, operation, target string, req, res map[string]interface{}, opErr error) {
	status := "success"
	errMsg := ""
	if opErr != nil {
		status = "failed"
		errMsg = opErr.Error()
	}
	_, _ = db.ExecContext(ctx, `INSERT INTO github_operation_audit (repository_id, operation, target, status, request_json, response_json, error_message)
		VALUES (?, ?, ?, ?, ?, ?, ?)`, repoID, operation, target, status, jsonString(req), jsonString(res), errMsg)
}

func safeTokens(tokens []Token) []map[string]interface{} {
	result := make([]map[string]interface{}, 0, len(tokens))
	for _, token := range tokens {
		result = append(result, safeToken(token))
	}
	return result
}

func safeToken(token Token) map[string]interface{} {
	item := map[string]interface{}{
		"id": token.ID, "name": token.Name, "type": token.Type, "enabled": token.Enabled,
		"default_token": token.DefaultToken, "note": token.Note, "account_login": token.AccountLogin, "scopes": token.Scopes,
		"permissions_json": token.PermissionsJSON, "last_test_status": token.LastTestStatus,
		"created_at": token.CreatedAt, "updated_at": token.UpdatedAt, "has_token": token.TokenEncrypted != "",
	}
	if token.LastTestError != "" {
		item["last_test_error"] = token.LastTestError
	}
	if token.LastTestAt != nil {
		item["last_test_at"] = *token.LastTestAt
	}
	return item
}

func verifySignature(body []byte, secret, signature string) bool {
	if secret == "" || signature == "" || !strings.HasPrefix(signature, "sha256=") {
		return false
	}
	mac := hmac.New(sha256.New, []byte(secret))
	mac.Write(body)
	expected := "sha256=" + hex.EncodeToString(mac.Sum(nil))
	return hmac.Equal([]byte(expected), []byte(signature))
}

func randomSecret() string {
	buf := make([]byte, 24)
	if _, err := rand.Read(buf); err != nil {
		return strconv.FormatInt(time.Now().UnixNano(), 36)
	}
	return hex.EncodeToString(buf)
}

func parseRepoInput(input string) (string, string) {
	raw := strings.TrimSpace(strings.TrimSuffix(input, ".git"))
	if raw == "" {
		return "", ""
	}
	if strings.HasPrefix(raw, "git@github.com:") {
		raw = strings.TrimPrefix(raw, "git@github.com:")
	} else if strings.HasPrefix(raw, "http://") || strings.HasPrefix(raw, "https://") {
		parsed, err := url.Parse(raw)
		if err != nil || !strings.EqualFold(parsed.Host, "github.com") {
			return "", ""
		}
		raw = strings.Trim(parsed.Path, "/")
	}
	parts := strings.Split(strings.Trim(raw, "/"), "/")
	if len(parts) < 2 {
		return "", ""
	}
	return cleanRepoPart(parts[0]), cleanRepoPart(parts[1])
}

func cleanRepoPart(value string) string {
	return strings.Trim(strings.TrimSpace(value), "/")
}
