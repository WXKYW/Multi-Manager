package serveragent

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"time"

	"github.com/iwvw/api-monitor/backend-go/internal/reconcilequeue"
	"github.com/iwvw/api-monitor/backend-go/internal/subscriptionledger"
)

func (s *Service) startSubscriptionReconcileLoop(ctx context.Context) {
	ticker := time.NewTicker(3 * time.Second)
	cycleTicker := time.NewTicker(time.Minute)
	defer ticker.Stop()
	defer cycleTicker.Stop()
	s.scheduleSubscriptionCycleTransitions(ctx)
	for {
		select {
		case <-ctx.Done():
			return
		case <-cycleTicker.C:
			s.scheduleSubscriptionCycleTransitions(ctx)
		case <-ticker.C:
			for processed := 0; processed < 8; processed++ {
				if !s.processSubscriptionReconcileJob(ctx) {
					break
				}
			}
		}
	}
}

func (s *Service) scheduleSubscriptionCycleTransitions(parent context.Context) {
	ctx, cancel := context.WithTimeout(parent, 30*time.Second)
	defer cancel()
	db, err := s.open(ctx)
	if err != nil {
		return
	}
	defer db.Close()
	_ = subscriptionledger.ScheduleCycleTransitions(ctx, db, time.Now().UTC())
}

func (s *Service) processSubscriptionReconcileJob(parent context.Context) bool {
	ctx, cancel := context.WithTimeout(parent, 6*time.Minute)
	defer cancel()
	db, err := s.open(ctx)
	if err != nil {
		return false
	}
	defer db.Close()
	job, ok, err := reconcilequeue.Claim(ctx, db, time.Now().UTC())
	if err != nil || !ok {
		return false
	}

	var serverID string
	err = db.QueryRowContext(ctx, `SELECT server_id FROM managed_proxy_nodes WHERE id=?`, job.NodeID).Scan(&serverID)
	if errors.Is(err, sql.ErrNoRows) {
		_ = reconcilequeue.Complete(ctx, db, job)
		return true
	}
	if err != nil {
		_ = reconcilequeue.Retry(ctx, db, job, err, time.Now().UTC())
		return true
	}
	connection, online := s.registry.Get(serverID)
	if !online {
		_ = reconcilequeue.Retry(ctx, db, job, errors.New("agent offline; subscriber runtime sync is queued"), time.Now().UTC())
		return true
	}
	if !connection.GetCapabilities()["proxy_runtime_v1"] {
		_ = reconcilequeue.Retry(ctx, db, job, errors.New("agent version does not support managed proxy runtime"), time.Now().UTC())
		return true
	}
	if !connection.GetCapabilities()["proxy_user_traffic_v1"] {
		_ = reconcilequeue.Retry(ctx, db, job, errors.New("agent version does not support subscriber traffic accounting"), time.Now().UTC())
		return true
	}
	task, err := s.taskRegistry.CreateExclusive(serverID, "proxy.subscribers.reconcile", job.NodeID, proxyTaskResource(serverID))
	if err != nil {
		_ = reconcilequeue.Retry(ctx, db, job, err, time.Now().UTC())
		return true
	}
	result, err := db.ExecContext(ctx, `UPDATE managed_proxy_nodes SET revision=revision+1,apply_status='pending',last_error='',updated_at=datetime('now') WHERE id=?`, job.NodeID)
	if err != nil {
		s.taskRegistry.Fail(task.ID, err.Error())
		_ = reconcilequeue.Retry(ctx, db, job, err, time.Now().UTC())
		return true
	}
	if affected, _ := result.RowsAffected(); affected != 1 {
		s.taskRegistry.Complete(task.ID, "node was removed before subscriber synchronization")
		_ = reconcilequeue.Complete(ctx, db, job)
		return true
	}

	s.applyManagedProxyNodeTask(task.ID, job.NodeID)
	var applyStatus, lastError string
	err = db.QueryRowContext(ctx, `SELECT apply_status,COALESCE(last_error,'') FROM managed_proxy_nodes WHERE id=?`, job.NodeID).Scan(&applyStatus, &lastError)
	if errors.Is(err, sql.ErrNoRows) {
		_ = reconcilequeue.Complete(ctx, db, job)
		return true
	}
	if err == nil && (applyStatus == "running" || applyStatus == "stopped") {
		_ = reconcilequeue.Complete(ctx, db, job)
		return true
	}
	if err == nil {
		err = fmt.Errorf("subscriber runtime sync ended in %s: %s", applyStatus, lastError)
	}
	_ = reconcilequeue.Retry(ctx, db, job, err, time.Now().UTC())
	return true
}
