package database

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/iwvw/api-monitor/backend-go/internal/config"
)

func TestStoreEnablesSQLiteForeignKeys(t *testing.T) {
	cfg := config.Config{DataDir: t.TempDir()}
	cfg.DBName = "foreign-keys.db"
	db, err := New(cfg).Open(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	var enabled int
	if err := db.QueryRow(`PRAGMA foreign_keys`).Scan(&enabled); err != nil {
		t.Fatal(err)
	}
	if enabled != 1 {
		t.Fatalf("foreign_keys=%d, want 1", enabled)
	}
}

func TestStoreConfiguresSQLiteForWALWorkloads(t *testing.T) {
	cfg := config.Config{DataDir: t.TempDir(), DBName: "wal-performance.db"}
	db, err := New(cfg).Open(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()

	var journalMode string
	var synchronous int
	var tempStore int
	if err := db.QueryRow(`PRAGMA journal_mode`).Scan(&journalMode); err != nil {
		t.Fatal(err)
	}
	if err := db.QueryRow(`PRAGMA synchronous`).Scan(&synchronous); err != nil {
		t.Fatal(err)
	}
	if err := db.QueryRow(`PRAGMA temp_store`).Scan(&tempStore); err != nil {
		t.Fatal(err)
	}
	if journalMode != "wal" || synchronous != 1 || tempStore != 2 {
		t.Fatalf("journal_mode=%q synchronous=%d temp_store=%d, want wal/1/2", journalMode, synchronous, tempStore)
	}
}

func TestWithSchemaLockSerializesMigrations(t *testing.T) {
	firstEntered := make(chan struct{})
	releaseFirst := make(chan struct{})
	firstDone := make(chan error, 1)
	go func() {
		firstDone <- WithSchemaLock(context.Background(), func() error {
			close(firstEntered)
			<-releaseFirst
			return nil
		})
	}()
	<-firstEntered

	secondEntered := make(chan struct{})
	secondDone := make(chan error, 1)
	go func() {
		secondDone <- WithSchemaLock(context.Background(), func() error {
			close(secondEntered)
			return nil
		})
	}()

	select {
	case <-secondEntered:
		close(releaseFirst)
		t.Fatal("second migration entered while the schema lock was held")
	case <-time.After(50 * time.Millisecond):
	}
	close(releaseFirst)
	if err := <-firstDone; err != nil {
		t.Fatalf("first migration: %v", err)
	}
	select {
	case err := <-secondDone:
		if err != nil {
			t.Fatalf("second migration: %v", err)
		}
	case <-time.After(time.Second):
		t.Fatal("second migration did not proceed after the schema lock was released")
	}
}

func TestWithSchemaLockHonorsContextCancellation(t *testing.T) {
	firstEntered := make(chan struct{})
	releaseFirst := make(chan struct{})
	firstDone := make(chan error, 1)
	go func() {
		firstDone <- WithSchemaLock(context.Background(), func() error {
			close(firstEntered)
			<-releaseFirst
			return nil
		})
	}()
	<-firstEntered

	ctx, cancel := context.WithTimeout(context.Background(), 50*time.Millisecond)
	defer cancel()
	err := WithSchemaLock(ctx, func() error {
		t.Fatal("cancelled migration must not enter the critical section")
		return nil
	})
	if !errors.Is(err, context.DeadlineExceeded) {
		close(releaseFirst)
		t.Fatalf("WithSchemaLock error = %v, want context deadline exceeded", err)
	}

	close(releaseFirst)
	if err := <-firstDone; err != nil {
		t.Fatalf("first migration: %v", err)
	}
}
