package database

import "context"

var schemaLock = make(chan struct{}, 1)

func init() {
	schemaLock <- struct{}{}
}

// WithSchemaLock serializes schema inspection and DDL across backend modules.
// SQLite serializes individual writes, but the common "inspect then ALTER"
// sequence is otherwise vulnerable to duplicate-column races during startup.
func WithSchemaLock(ctx context.Context, migrate func() error) error {
	select {
	case <-ctx.Done():
		return ctx.Err()
	case <-schemaLock:
	}
	defer func() { schemaLock <- struct{}{} }()
	return migrate()
}
