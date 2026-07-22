package serveragent

import (
	"context"
	"fmt"
	"time"

	"github.com/iwvw/api-monitor/backend-go/internal/database"
)

type taskPersistence interface {
	Ensure(context.Context) error
	Save(context.Context, *Task) error
	LoadRecent(context.Context, time.Duration) ([]*Task, error)
	Prune(context.Context, time.Time) error
}

type sqliteTaskPersistence struct {
	store *database.Store
}

func newSQLiteTaskPersistence(store *database.Store) *sqliteTaskPersistence {
	return &sqliteTaskPersistence{store: store}
}

func (p *sqliteTaskPersistence) Ensure(ctx context.Context) error {
	db, err := p.store.Open(ctx)
	if err != nil {
		return err
	}
	defer db.Close()
	_, err = db.ExecContext(ctx, `CREATE TABLE IF NOT EXISTS server_orchestration_tasks (
		id TEXT PRIMARY KEY,
		server_id TEXT NOT NULL DEFAULT '',
		task_type TEXT NOT NULL,
		command_summary TEXT NOT NULL DEFAULT '',
		status TEXT NOT NULL,
		progress INTEGER NOT NULL DEFAULT 0,
		result TEXT NOT NULL DEFAULT '',
		error TEXT NOT NULL DEFAULT '',
		created_at TEXT NOT NULL,
		started_at TEXT,
		completed_at TEXT,
		updated_at TEXT NOT NULL DEFAULT (datetime('now'))
	)`)
	if err != nil {
		return fmt.Errorf("ensure orchestration task schema: %w", err)
	}
	_, err = db.ExecContext(ctx, `CREATE INDEX IF NOT EXISTS idx_server_orchestration_tasks_server_created ON server_orchestration_tasks(server_id,created_at DESC)`)
	return err
}

func (p *sqliteTaskPersistence) Save(ctx context.Context, task *Task) error {
	if task == nil {
		return nil
	}
	task.mu.RLock()
	id, serverID, taskType, command := task.ID, task.ServerID, task.Type, task.Command
	status, progress, result, taskError := task.Status, task.Progress, task.Result, task.Error
	createdAt, startedAt, completedAt := task.CreatedAt, task.StartedAt, task.CompletedAt
	task.mu.RUnlock()
	db, err := p.store.Open(ctx)
	if err != nil {
		return err
	}
	defer db.Close()
	_, err = db.ExecContext(ctx, `INSERT INTO server_orchestration_tasks(id,server_id,task_type,command_summary,status,progress,result,error,created_at,started_at,completed_at,updated_at)
		VALUES(?,?,?,?,?,?,?,?,?,?,?,datetime('now'))
		ON CONFLICT(id) DO UPDATE SET status=excluded.status,progress=excluded.progress,result=excluded.result,error=excluded.error,started_at=excluded.started_at,completed_at=excluded.completed_at,updated_at=datetime('now')`,
		id, serverID, taskType, command, string(status), progress, result, taskError, formatTaskTime(createdAt), nullableTaskTime(startedAt), nullableTaskTime(completedAt))
	return err
}

func (p *sqliteTaskPersistence) LoadRecent(ctx context.Context, retention time.Duration) ([]*Task, error) {
	db, err := p.store.Open(ctx)
	if err != nil {
		return nil, err
	}
	defer db.Close()
	cutoff := time.Now().Add(-retention).UTC().Format(time.RFC3339Nano)
	rows, err := db.QueryContext(ctx, `SELECT id,server_id,task_type,command_summary,status,progress,result,error,created_at,COALESCE(started_at,''),COALESCE(completed_at,'') FROM server_orchestration_tasks WHERE created_at>=? ORDER BY created_at ASC`, cutoff)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	tasks := []*Task{}
	for rows.Next() {
		var task Task
		var status, createdAt, startedAt, completedAt string
		if err := rows.Scan(&task.ID, &task.ServerID, &task.Type, &task.Command, &status, &task.Progress, &task.Result, &task.Error, &createdAt, &startedAt, &completedAt); err != nil {
			return nil, err
		}
		task.Status = TaskStatus(status)
		task.CreatedAt = parseTaskTime(createdAt)
		task.StartedAt = parseNullableTaskTime(startedAt)
		task.CompletedAt = parseNullableTaskTime(completedAt)
		task.subscribers = []chan TaskEvent{}
		tasks = append(tasks, &task)
	}
	return tasks, rows.Err()
}

func (p *sqliteTaskPersistence) Prune(ctx context.Context, cutoff time.Time) error {
	db, err := p.store.Open(ctx)
	if err != nil {
		return err
	}
	defer db.Close()
	_, err = db.ExecContext(ctx, `DELETE FROM server_orchestration_tasks WHERE completed_at IS NOT NULL AND completed_at<?`, formatTaskTime(cutoff))
	return err
}

func formatTaskTime(value time.Time) string {
	return value.UTC().Format(time.RFC3339Nano)
}

func nullableTaskTime(value *time.Time) interface{} {
	if value == nil {
		return nil
	}
	return formatTaskTime(*value)
}

func parseTaskTime(value string) time.Time {
	parsed, err := time.Parse(time.RFC3339Nano, value)
	if err != nil {
		return time.Now()
	}
	return parsed
}

func parseNullableTaskTime(value string) *time.Time {
	if value == "" {
		return nil
	}
	parsed, err := time.Parse(time.RFC3339Nano, value)
	if err != nil {
		return nil
	}
	return &parsed
}

var _ taskPersistence = (*sqliteTaskPersistence)(nil)
