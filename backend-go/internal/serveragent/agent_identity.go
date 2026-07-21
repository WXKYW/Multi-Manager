package serveragent

import (
	"context"
	"crypto/rand"
	"crypto/subtle"
	"database/sql"
	"encoding/hex"
	"errors"
	"fmt"
	"strings"

	"github.com/iwvw/api-monitor/backend-go/internal/secure"
)

// agentCredential is deliberately scoped to one managed host. Keeping the
// secret encrypted (rather than hashed) allows the installer to be regenerated
// without silently invalidating an already enrolled Agent.
func (s *Service) getOrGenerateAgentKeyForServer(ctx context.Context, db *sql.DB, serverID string) (string, error) {
	serverID = strings.TrimSpace(serverID)
	if serverID == "" {
		return "", errors.New("server_id is required")
	}
	var encrypted string
	err := db.QueryRowContext(ctx, `SELECT secret_encrypted FROM server_agent_credentials WHERE server_id = ?`, serverID).Scan(&encrypted)
	if err == nil {
		secret := secure.SecureDecrypt(encrypted)
		if strings.TrimSpace(secret) != "" {
			return secret, nil
		}
	} else if !errors.Is(err, sql.ErrNoRows) {
		return "", err
	}

	bytes := make([]byte, 32)
	if _, err := rand.Read(bytes); err != nil {
		return "", err
	}
	secret := hex.EncodeToString(bytes)
	encrypted, err = secure.SecureEncrypt(secret)
	if err != nil {
		return "", fmt.Errorf("encrypt agent credential: %w", err)
	}
	_, err = db.ExecContext(ctx, `INSERT INTO server_agent_credentials (server_id, secret_encrypted, created_at, updated_at)
		VALUES (?, ?, datetime('now'), datetime('now'))
		ON CONFLICT(server_id) DO UPDATE SET secret_encrypted = excluded.secret_encrypted, updated_at = datetime('now')`, serverID, encrypted)
	if err != nil {
		return "", err
	}
	return secret, nil
}

func (s *Service) validateAgentKeyForServer(ctx context.Context, db *sql.DB, serverID, provided string) error {
	provided = strings.TrimSpace(provided)
	var encrypted string
	err := db.QueryRowContext(ctx, `SELECT secret_encrypted FROM server_agent_credentials WHERE server_id = ?`, strings.TrimSpace(serverID)).Scan(&encrypted)
	if err == nil {
		expected := secure.SecureDecrypt(encrypted)
		if constantTimeSecretEqual(expected, provided) {
			return nil
		}
		return errors.New("invalid agent key")
	}
	if !errors.Is(err, sql.ErrNoRows) {
		return err
	}

	// Seamless migration for already installed Agents: accept the former
	// global credential once, then pin it to this machine. Fresh enrollments
	// always receive independently generated credentials.
	legacy, legacyErr := s.getOrGenerateAgentKey(ctx, db)
	if legacyErr != nil || !constantTimeSecretEqual(legacy, provided) {
		return errors.New("invalid agent key")
	}
	encrypted, err = secure.SecureEncrypt(provided)
	if err != nil {
		return err
	}
	if _, err = db.ExecContext(ctx, `INSERT OR IGNORE INTO server_agent_credentials (server_id, secret_encrypted, created_at, updated_at)
		VALUES (?, ?, datetime('now'), datetime('now'))`, serverID, encrypted); err != nil {
		return err
	}
	return nil
}

func constantTimeSecretEqual(expected, provided string) bool {
	if len(expected) != len(provided) || len(expected) == 0 {
		return false
	}
	return subtle.ConstantTimeCompare([]byte(expected), []byte(provided)) == 1
}
