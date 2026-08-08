package openai

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"database/sql"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"net/http"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/iwvw/api-monitor/backend-go/internal/apikeys"
	"github.com/iwvw/api-monitor/backend-go/internal/response"
	"github.com/iwvw/api-monitor/backend-go/internal/secure"
)

type gatewayKeyContextKey struct{}

type GatewayKey struct {
	ID           string  `json:"id"`
	Name         string  `json:"name"`
	KeyPrefix    string  `json:"keyPrefix"`
	KeySuffix    string  `json:"keySuffix"`
	MaskedKey    string  `json:"maskedKey"`
	APIKey       string  `json:"apiKey,omitempty"`
	Enabled      bool    `json:"enabled"`
	IsDefault    bool    `json:"isDefault"`
	CreatedAt    string  `json:"createdAt"`
	LastUsed     *string `json:"lastUsed"`
	ExpiresAt    *string `json:"expiresAt"`
	RequestCount int64   `json:"requestCount"`
}

type gatewayKeyIdentity struct {
	ID   string
	Name string
}

var (
	errGatewayKeyMissing  = errors.New("缺少 API Key")
	errGatewayKeyInvalid  = errors.New("API Key 无效或已禁用")
	errGatewayKeyExpired  = errors.New("API Key 已过期")
	errGatewayKeyNotFound = errors.New("API Key 不存在")
)

func gatewayKeyFromContext(ctx context.Context) gatewayKeyIdentity {
	identity, _ := ctx.Value(gatewayKeyContextKey{}).(gatewayKeyIdentity)
	return identity
}

func (s *Service) AuthorizeGatewayRequest(r *http.Request) (*http.Request, error) {
	rawKey := strings.TrimSpace(r.Header.Get("X-API-Key"))
	if rawKey == "" {
		authHeader := strings.TrimSpace(r.Header.Get("Authorization"))
		if strings.HasPrefix(strings.ToLower(authHeader), "bearer ") {
			rawKey = strings.TrimSpace(authHeader[len("Bearer "):])
		}
	}
	if rawKey == "" {
		return r, errGatewayKeyMissing
	}

	if key, err := s.apiKeys.Authorize(r.Context(), r, apikeys.ScopeOpenAIGateway); err == nil {
		identity := gatewayKeyIdentity{ID: key.ID, Name: key.Name}
		return r.WithContext(context.WithValue(r.Context(), gatewayKeyContextKey{}, identity)), nil
	} else if errors.Is(err, apikeys.ErrExpired) {
		return r, errGatewayKeyExpired
	} else if errors.Is(err, apikeys.ErrDisabled) {
		return r, errGatewayKeyInvalid
	}

	ctx := r.Context()
	db, err := s.open(ctx)
	if err != nil {
		return r, err
	}
	defer db.Close()

	var identity gatewayKeyIdentity
	var enabledInt int
	var expiresAt sql.NullString
	err = db.QueryRowContext(ctx, `
		SELECT id, name, enabled, expires_at
		FROM openai_gateway_keys
		WHERE key_hash = ?
		LIMIT 1`, hashGatewayKey(rawKey)).
		Scan(&identity.ID, &identity.Name, &enabledInt, &expiresAt)
	if errors.Is(err, sql.ErrNoRows) || enabledInt != 1 {
		return r, errGatewayKeyInvalid
	}
	if err != nil {
		return r, err
	}
	if expiresAt.Valid {
		expires, parseErr := time.Parse(time.RFC3339, expiresAt.String)
		if parseErr == nil && !expires.After(time.Now()) {
			return r, errGatewayKeyExpired
		}
	}

	now := time.Now().Format(time.RFC3339)
	_, _ = db.ExecContext(ctx, `
		UPDATE openai_gateway_keys
		SET last_used = ?, request_count = request_count + 1
		WHERE id = ?`, now, identity.ID)

	return r.WithContext(context.WithValue(ctx, gatewayKeyContextKey{}, identity)), nil
}

func (s *Service) listGatewayKeys(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	db, err := s.open(ctx)
	if err != nil {
		response.JSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}
	defer db.Close()

	rows, err := db.QueryContext(ctx, `
		SELECT id, name, key_cipher, key_prefix, key_suffix, enabled, is_default, created_at, last_used, expires_at, request_count
		FROM openai_gateway_keys
		ORDER BY is_default DESC, created_at DESC`)
	if err != nil {
		response.JSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}
	defer rows.Close()

	keys := []GatewayKey{}
	for rows.Next() {
		key, scanErr := scanGatewayKey(rows)
		if scanErr != nil {
			response.JSON(w, http.StatusInternalServerError, map[string]string{"error": scanErr.Error()})
			return
		}
		keys = append(keys, key)
	}
	response.JSON(w, http.StatusOK, keys)
}

func (s *Service) createGatewayKey(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Name      string `json:"name"`
		ExpiresAt string `json:"expiresAt"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		response.JSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
		return
	}
	req.Name = strings.TrimSpace(req.Name)
	if req.Name == "" {
		response.JSON(w, http.StatusBadRequest, map[string]string{"error": "密钥名称必填"})
		return
	}

	expiresAt, err := normalizeGatewayKeyExpiry(req.ExpiresAt)
	if err != nil {
		response.JSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
		return
	}
	rawKey, err := generateGatewayKey()
	if err != nil {
		response.JSON(w, http.StatusInternalServerError, map[string]string{"error": "生成 API Key 失败"})
		return
	}
	ctx := r.Context()
	db, err := s.open(ctx)
	if err != nil {
		response.JSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}
	defer db.Close()

	id := "gk_" + uuid.NewString()
	createdAt := time.Now().Format(time.RFC3339)
	prefix, suffix := gatewayKeyParts(rawKey)
	_, err = db.ExecContext(ctx, `
		INSERT INTO openai_gateway_keys
			(id, name, key_hash, key_cipher, key_prefix, key_suffix, enabled, created_at, expires_at)
		VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?)`,
		id, req.Name, hashGatewayKey(rawKey), rawKey, prefix, suffix, createdAt, expiresAt)
	if err != nil {
		response.JSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}

	response.JSON(w, http.StatusCreated, map[string]interface{}{
		"success": true,
		"apiKey":  rawKey,
		"key": GatewayKey{
			ID:        id,
			Name:      req.Name,
			KeyPrefix: prefix,
			KeySuffix: suffix,
			MaskedKey: maskGatewayKey(prefix, suffix),
			Enabled:   true,
			CreatedAt: createdAt,
			ExpiresAt: nullableStringPointer(expiresAt),
		},
	})
}

func (s *Service) updateGatewayKey(w http.ResponseWriter, r *http.Request, id string) {
	var req struct {
		Name      string `json:"name"`
		ExpiresAt string `json:"expiresAt"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		response.JSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
		return
	}
	req.Name = strings.TrimSpace(req.Name)
	if req.Name == "" {
		response.JSON(w, http.StatusBadRequest, map[string]string{"error": "密钥名称必填"})
		return
	}
	expiresAt, err := normalizeGatewayKeyExpiry(req.ExpiresAt)
	if err != nil {
		response.JSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
		return
	}

	db, err := s.open(r.Context())
	if err != nil {
		response.JSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}
	defer db.Close()
	result, err := db.ExecContext(r.Context(), `
		UPDATE openai_gateway_keys SET name = ?, expires_at = ? WHERE id = ?`,
		req.Name, expiresAt, id)
	if err != nil {
		response.JSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}
	affected, _ := result.RowsAffected()
	if affected == 0 {
		response.JSON(w, http.StatusNotFound, map[string]string{"error": errGatewayKeyNotFound.Error()})
		return
	}
	response.JSON(w, http.StatusOK, map[string]interface{}{"success": true})
}

func (s *Service) toggleGatewayKey(w http.ResponseWriter, r *http.Request, id string) {
	var req struct {
		Enabled bool `json:"enabled"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		response.JSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
		return
	}
	enabled := 0
	if req.Enabled {
		enabled = 1
	}

	db, err := s.open(r.Context())
	if err != nil {
		response.JSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}
	defer db.Close()
	result, err := db.ExecContext(r.Context(), "UPDATE openai_gateway_keys SET enabled = ? WHERE id = ?", enabled, id)
	if err != nil {
		response.JSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}
	writeGatewayKeyMutationResult(w, result)
}

func (s *Service) rotateGatewayKey(w http.ResponseWriter, r *http.Request, id string) {
	rawKey, err := generateGatewayKey()
	if err != nil {
		response.JSON(w, http.StatusInternalServerError, map[string]string{"error": "生成 API Key 失败"})
		return
	}
	prefix, suffix := gatewayKeyParts(rawKey)

	db, err := s.open(r.Context())
	if err != nil {
		response.JSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}
	defer db.Close()
	result, err := db.ExecContext(r.Context(), `
		UPDATE openai_gateway_keys
		SET key_hash = ?, key_cipher = ?, key_prefix = ?, key_suffix = ?, last_used = NULL, request_count = 0
		WHERE id = ?`, hashGatewayKey(rawKey), rawKey, prefix, suffix, id)
	if err != nil {
		response.JSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}
	affected, _ := result.RowsAffected()
	if affected == 0 {
		response.JSON(w, http.StatusNotFound, map[string]string{"error": errGatewayKeyNotFound.Error()})
		return
	}
	response.JSON(w, http.StatusOK, map[string]interface{}{"success": true, "apiKey": rawKey})
}

func (s *Service) setDefaultGatewayKey(w http.ResponseWriter, r *http.Request, id string) {
	ctx := r.Context()
	db, err := s.open(ctx)
	if err != nil {
		response.JSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}
	defer db.Close()

	tx, err := db.BeginTx(ctx, nil)
	if err != nil {
		response.JSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}
	defer tx.Rollback()

	var exists int
	if err := tx.QueryRowContext(ctx, "SELECT 1 FROM openai_gateway_keys WHERE id = ?", id).Scan(&exists); err != nil {
		response.JSON(w, http.StatusNotFound, map[string]string{"error": errGatewayKeyNotFound.Error()})
		return
	}
	if _, err := tx.ExecContext(ctx, "UPDATE openai_gateway_keys SET is_default = 0"); err != nil {
		response.JSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}
	if _, err := tx.ExecContext(ctx, "UPDATE openai_gateway_keys SET is_default = 1 WHERE id = ?", id); err != nil {
		response.JSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}
	if err := tx.Commit(); err != nil {
		response.JSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}
	response.JSON(w, http.StatusOK, map[string]interface{}{"success": true})
}

func (s *Service) deleteGatewayKey(w http.ResponseWriter, r *http.Request, id string) {
	db, err := s.open(r.Context())
	if err != nil {
		response.JSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}
	defer db.Close()
	result, err := db.ExecContext(r.Context(), "DELETE FROM openai_gateway_keys WHERE id = ?", id)
	if err != nil {
		response.JSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}
	writeGatewayKeyMutationResult(w, result)
}

func scanGatewayKey(scanner interface {
	Scan(dest ...interface{}) error
}) (GatewayKey, error) {
	var key GatewayKey
	var enabled int
	var isDefault int
	var keyCipher, lastUsed, expiresAt sql.NullString
	err := scanner.Scan(
		&key.ID,
		&key.Name,
		&keyCipher,
		&key.KeyPrefix,
		&key.KeySuffix,
		&enabled,
		&isDefault,
		&key.CreatedAt,
		&lastUsed,
		&expiresAt,
		&key.RequestCount,
	)
	if err != nil {
		return key, err
	}
	key.Enabled = enabled == 1
	key.IsDefault = isDefault == 1
	key.MaskedKey = maskGatewayKey(key.KeyPrefix, key.KeySuffix)
	if keyCipher.Valid && secure.IsEncrypted(keyCipher.String) {
		if rawKey, decryptErr := secure.DecryptNodeGCM(keyCipher.String); decryptErr == nil {
			key.APIKey = rawKey
		}
	} else if keyCipher.Valid {
		key.APIKey = keyCipher.String
	}
	if lastUsed.Valid {
		key.LastUsed = &lastUsed.String
	}
	if expiresAt.Valid {
		key.ExpiresAt = &expiresAt.String
	}
	return key, nil
}

func writeGatewayKeyMutationResult(w http.ResponseWriter, result sql.Result) {
	affected, _ := result.RowsAffected()
	if affected == 0 {
		response.JSON(w, http.StatusNotFound, map[string]string{"error": errGatewayKeyNotFound.Error()})
		return
	}
	response.JSON(w, http.StatusOK, map[string]interface{}{"success": true})
}

func generateGatewayKey() (string, error) {
	bytes := make([]byte, 24)
	if _, err := rand.Read(bytes); err != nil {
		return "", err
	}
	return "sk-am-" + base64.RawURLEncoding.EncodeToString(bytes), nil
}

func hashGatewayKey(rawKey string) string {
	sum := sha256.Sum256([]byte(strings.TrimSpace(rawKey)))
	return hex.EncodeToString(sum[:])
}

func gatewayKeyParts(rawKey string) (string, string) {
	if len(rawKey) <= 12 {
		return rawKey, rawKey
	}
	return rawKey[:10], rawKey[len(rawKey)-4:]
}

func maskGatewayKey(prefix, suffix string) string {
	return prefix + "..." + suffix
}

func normalizeGatewayKeyExpiry(value string) (interface{}, error) {
	value = strings.TrimSpace(value)
	if value == "" {
		return nil, nil
	}
	parsed, err := time.Parse(time.RFC3339, value)
	if err != nil {
		return nil, errors.New("过期时间格式无效")
	}
	if !parsed.After(time.Now()) {
		return nil, errors.New("过期时间必须晚于当前时间")
	}
	return parsed.Format(time.RFC3339), nil
}

func nullableStringPointer(value interface{}) *string {
	text, ok := value.(string)
	if !ok || text == "" {
		return nil
	}
	return &text
}
