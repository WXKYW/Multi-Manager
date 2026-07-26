package database

import "sync"

// SchemaEnsurer 让各服务的幂等 schema DDL 进程内只执行一次，
// 避免每次 Open 连接都重放 CREATE TABLE / ALTER。
type SchemaEnsurer struct {
	once sync.Once
	err  error
}

// Ensure 首次调用执行 fn 并缓存结果，后续调用直接返回缓存的错误。
func (e *SchemaEnsurer) Ensure(fn func() error) error {
	e.once.Do(func() {
		e.err = fn()
	})
	return e.err
}
