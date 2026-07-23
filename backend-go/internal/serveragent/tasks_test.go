package serveragent

import (
	"context"
	"errors"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/iwvw/api-monitor/backend-go/internal/config"
	"github.com/iwvw/api-monitor/backend-go/internal/database"
)

func TestTaskLateSubscriberReceivesTerminalResult(t *testing.T) {
	registry := NewTaskRegistry()
	task := registry.Create("server-1", "proxy.node.reconcile", "node-1")
	registry.Complete(task.ID, "node ready")
	event := <-task.Subscribe()
	if event.Status != TaskCompleted || event.Data != "node ready" {
		t.Fatalf("late subscriber event = %#v", event)
	}
}

func TestTaskExclusiveResourceReleasedAfterTerminalState(t *testing.T) {
	registry := NewTaskRegistry()
	first, err := registry.CreateExclusive("server-1", "proxy.runtime.install", "install", "proxy:server-1")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := registry.CreateExclusive("server-1", "proxy.node.reconcile", "node-1", "proxy:server-1"); !errors.Is(err, ErrTaskResourceBusy) {
		t.Fatalf("second task error = %v", err)
	}
	registry.Complete(first.ID, "ready")
	if _, err := registry.CreateExclusive("server-1", "proxy.node.reconcile", "node-1", "proxy:server-1"); err != nil {
		t.Fatalf("resource was not released: %v", err)
	}
}

func TestTaskPersistenceRecoversInterruptedTaskAsFailed(t *testing.T) {
	ctx := context.Background()
	store := database.New(config.Config{DataDir: t.TempDir(), DBName: filepath.Base("tasks.db")})
	persistence := newSQLiteTaskPersistence(store)
	if err := persistence.Ensure(ctx); err != nil {
		t.Fatal(err)
	}
	created := NewTaskRegistry()
	created.persistence = persistence
	task := created.Create("server-1", "proxy.runtime.install", "install")
	created.UpdateProgress(task.ID, 40, nil)

	recovered := NewTaskRegistry()
	if err := recovered.AttachPersistence(ctx, persistence); err != nil {
		t.Fatal(err)
	}
	restored, ok := recovered.Get(task.ID)
	if !ok || restored.GetStatus() != TaskFailed {
		t.Fatalf("restored task = %#v", restored)
	}
	if event := restored.Snapshot(); !strings.Contains(event.Error, "backend restarted") {
		t.Fatalf("restored error = %q", event.Error)
	}
	loaded, err := persistence.LoadRecent(ctx, 24*time.Hour)
	if err != nil || len(loaded) != 1 || loaded[0].Status != TaskFailed {
		t.Fatalf("persisted recovery = %#v, %v", loaded, err)
	}
}

func TestStreamTaskReplaysCompletedTask(t *testing.T) {
	registry := NewTaskRegistry()
	task := registry.Create("server-1", "proxy.node.reconcile", "node-1")
	registry.Complete(task.ID, "node ready")
	req := httptest.NewRequest("GET", "/api/server/tasks/"+task.ID+"/stream", nil)
	recorder := httptest.NewRecorder()
	service := &Service{}
	service.streamTask(recorder, req, registry, task.ID)
	body := recorder.Body.String()
	if !strings.Contains(body, `"status":"completed"`) || !strings.Contains(body, "node ready") {
		t.Fatalf("completed task was not replayed: %s", body)
	}
}
