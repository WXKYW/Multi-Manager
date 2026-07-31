package drawio

import (
	"context"
	"fmt"
	"log"
	"sync"
	"time"
)

// Renderer 后台缩略图渲染器（第一阶段为 stub 实现）
type Renderer struct {
	store  *Store
	stop   chan struct{}
	mu     sync.Mutex
	running bool
}

func NewRenderer(store *Store) *Renderer {
	return &Renderer{
		store: store,
		stop:  make(chan struct{}),
	}
}

func (r *Renderer) Start(ctx context.Context) {
	r.mu.Lock()
	if r.running {
		r.mu.Unlock()
		return
	}
	r.running = true
	r.mu.Unlock()

	go r.loop(ctx)
}

func (r *Renderer) Stop() {
	r.mu.Lock()
	defer r.mu.Unlock()
	if !r.running {
		return
	}
	r.running = false
	close(r.stop)
}

func (r *Renderer) loop(ctx context.Context) {
	ticker := time.NewTicker(30 * time.Second)
	defer ticker.Stop()

	for {
		select {
		case <-r.stop:
			return
		case <-ticker.C:
			r.processPendingJobs(ctx)
		}
	}
}

func (r *Renderer) processPendingJobs(ctx context.Context) {
	// Stage 1: stub — render jobs are created but not processed yet.
	// In M3, this will use a headless browser to generate thumbnails.
	log.Println("[drawio] Renderer: checking pending jobs (stub)")
}

// EnqueueThumbnailRender 创建缩略图渲染任务
func (r *Renderer) EnqueueThumbnailRender(ctx context.Context, documentID int64, sourceKind string) (int64, error) {
	db, err := r.store.open(ctx)
	if err != nil {
		return 0, err
	}
	defer db.Close()

	now := time.Now().UTC().Format(time.RFC3339)
	result, err := db.ExecContext(ctx,
		`INSERT INTO drawio_render_jobs (document_id, source_kind, target_kind, format, trigger_source, status, created_at, updated_at)
		VALUES (?, ?, 'thumbnail', 'svg', 'manual', 'pending', ?, ?)`,
		documentID, sourceKind, now, now)
	if err != nil {
		return 0, fmt.Errorf("enqueue render job: %w", err)
	}

	id, _ := result.LastInsertId()
	return id, nil
}
