package github

import (
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"
)

func readObject(r *http.Request) (map[string]interface{}, error) {
	defer r.Body.Close()
	var payload map[string]interface{}
	if err := json.NewDecoder(r.Body).Decode(&payload); err != nil {
		return nil, err
	}
	if payload == nil {
		return nil, errors.New("request body must be an object")
	}
	return payload, nil
}

func parseID(raw string) (int64, error) {
	id, err := strconv.ParseInt(strings.TrimSpace(raw), 10, 64)
	if err != nil || id <= 0 {
		return 0, errors.New("invalid id")
	}
	return id, nil
}

func stringValue(payload map[string]interface{}, key, fallback string) string {
	if payload == nil {
		return fallback
	}
	return asString(payload[key], fallback)
}

func asString(value interface{}, fallback ...string) string {
	switch v := value.(type) {
	case string:
		return strings.TrimSpace(v)
	case []byte:
		return strings.TrimSpace(string(v))
	case nil:
		if len(fallback) > 0 {
			return fallback[0]
		}
		return ""
	default:
		s := strings.TrimSpace(fmt.Sprint(v))
		if s == "<nil>" {
			s = ""
		}
		if s == "" && len(fallback) > 0 {
			return fallback[0]
		}
		return s
	}
}

func objectValue(value interface{}) map[string]interface{} {
	if value == nil {
		return map[string]interface{}{}
	}
	if obj, ok := value.(map[string]interface{}); ok {
		return obj
	}
	return map[string]interface{}{}
}

func intValue(payload map[string]interface{}, key string, fallback int) int {
	if payload == nil {
		return fallback
	}
	return intFromAnyDefault(payload[key], fallback)
}

func intFromAny(value interface{}) int {
	return intFromAnyDefault(value, 0)
}

func intFromAnyDefault(value interface{}, fallback int) int {
	switch v := value.(type) {
	case int:
		return v
	case int64:
		return int(v)
	case float64:
		return int(v)
	case json.Number:
		n, err := v.Int64()
		if err == nil {
			return int(n)
		}
	case string:
		if n, err := strconv.Atoi(strings.TrimSpace(v)); err == nil {
			return n
		}
	}
	return fallback
}

func int64Value(value interface{}, fallback int64) int64 {
	switch v := value.(type) {
	case int64:
		return v
	case int:
		return int64(v)
	case float64:
		return int64(v)
	case json.Number:
		n, err := v.Int64()
		if err == nil {
			return n
		}
	case string:
		if n, err := strconv.ParseInt(strings.TrimSpace(v), 10, 64); err == nil {
			return n
		}
	}
	return fallback
}

func boolValue(value interface{}, fallback bool) bool {
	switch v := value.(type) {
	case bool:
		return v
	case int:
		return v != 0
	case float64:
		return v != 0
	case string:
		switch strings.ToLower(strings.TrimSpace(v)) {
		case "true", "1", "yes", "on", "enabled":
			return true
		case "false", "0", "no", "off", "disabled":
			return false
		}
	}
	return fallback
}

func boolInt(value bool) int {
	if value {
		return 1
	}
	return 0
}

func clamp(value, min, max int) int {
	if value < min {
		return min
	}
	if value > max {
		return max
	}
	return value
}

func firstNonEmpty(values ...string) string {
	for _, value := range values {
		if strings.TrimSpace(value) != "" {
			return strings.TrimSpace(value)
		}
	}
	return ""
}

func escapePathSegments(path string) string {
	parts := strings.Split(strings.Trim(path, "/"), "/")
	for i, part := range parts {
		parts[i] = url.PathEscape(part)
	}
	return strings.Join(parts, "/")
}

func intQuery(r *http.Request, key string, fallback int) int {
	if value := strings.TrimSpace(r.URL.Query().Get(key)); value != "" {
		if n, err := strconv.Atoi(value); err == nil {
			return n
		}
	}
	return fallback
}

func int64Query(r *http.Request, key string, fallback int64) int64 {
	if value := strings.TrimSpace(r.URL.Query().Get(key)); value != "" {
		if n, err := strconv.ParseInt(value, 10, 64); err == nil {
			return n
		}
	}
	return fallback
}

func timeOrNil(value time.Time) interface{} {
	if value.IsZero() {
		return nil
	}
	return value.UTC().Format(time.RFC3339)
}

func nullEmpty(value string) interface{} {
	if strings.TrimSpace(value) == "" {
		return nil
	}
	return value
}

func nullString(value sql.NullString) interface{} {
	if value.Valid {
		return value.String
	}
	return nil
}

func normalizeDBValue(value interface{}) interface{} {
	switch v := value.(type) {
	case []byte:
		return string(v)
	default:
		return v
	}
}
