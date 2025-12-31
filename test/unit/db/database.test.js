/**
 * 数据库服务模块测试
 * @module test/unit/db/database.test
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'fs';
import path from 'path';

// 测试用临时数据库路径
const TEST_DB_DIR = path.join(process.cwd(), 'test', 'tmp');
const TEST_DB_PATH = path.join(TEST_DB_DIR, 'test-db.sqlite');

// 确保测试目录存在
beforeAll(() => {
    if (!fs.existsSync(TEST_DB_DIR)) {
        fs.mkdirSync(TEST_DB_DIR, { recursive: true });
    }
});

// 清理测试数据库
afterAll(() => {
    if (fs.existsSync(TEST_DB_PATH)) {
        fs.unlinkSync(TEST_DB_PATH);
    }
});

describe('数据库基础功能', () => {
    describe('SQLite 连接', () => {
        it('better-sqlite3 应该能正常导入', async () => {
            const Database = (await import('better-sqlite3')).default;
            expect(Database).toBeDefined();
            expect(typeof Database).toBe('function');
        });

        it('应该能创建内存数据库', async () => {
            const Database = (await import('better-sqlite3')).default;
            const db = new Database(':memory:');

            expect(db).toBeDefined();
            expect(db.open).toBe(true);

            db.close();
        });

        it('应该能创建文件数据库', async () => {
            const Database = (await import('better-sqlite3')).default;
            const db = new Database(TEST_DB_PATH);

            expect(db).toBeDefined();
            expect(db.open).toBe(true);
            expect(fs.existsSync(TEST_DB_PATH)).toBe(true);

            db.close();
        });
    });

    describe('基本 CRUD 操作', () => {
        let db;

        beforeAll(async () => {
            const Database = (await import('better-sqlite3')).default;
            db = new Database(':memory:');

            // 创建测试表
            db.exec(`
        CREATE TABLE IF NOT EXISTS test_items (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          name TEXT NOT NULL,
          value TEXT,
          created_at TEXT DEFAULT CURRENT_TIMESTAMP
        )
      `);
        });

        afterAll(() => {
            if (db && db.open) {
                db.close();
            }
        });

        it('应该能插入数据', () => {
            const stmt = db.prepare('INSERT INTO test_items (name, value) VALUES (?, ?)');
            const result = stmt.run('test-name', 'test-value');

            expect(result.changes).toBe(1);
            expect(result.lastInsertRowid).toBeGreaterThan(0);
        });

        it('应该能查询数据', () => {
            const stmt = db.prepare('SELECT * FROM test_items WHERE name = ?');
            const row = stmt.get('test-name');

            expect(row).toBeDefined();
            expect(row.name).toBe('test-name');
            expect(row.value).toBe('test-value');
        });

        it('应该能更新数据', () => {
            const stmt = db.prepare('UPDATE test_items SET value = ? WHERE name = ?');
            const result = stmt.run('updated-value', 'test-name');

            expect(result.changes).toBe(1);

            const checkStmt = db.prepare('SELECT value FROM test_items WHERE name = ?');
            const row = checkStmt.get('test-name');
            expect(row.value).toBe('updated-value');
        });

        it('应该能删除数据', () => {
            const stmt = db.prepare('DELETE FROM test_items WHERE name = ?');
            const result = stmt.run('test-name');

            expect(result.changes).toBe(1);

            const checkStmt = db.prepare('SELECT * FROM test_items WHERE name = ?');
            const row = checkStmt.get('test-name');
            expect(row).toBeUndefined();
        });

        it('应该能批量查询', () => {
            // 插入多条数据
            const insertStmt = db.prepare('INSERT INTO test_items (name, value) VALUES (?, ?)');
            insertStmt.run('item-1', 'value-1');
            insertStmt.run('item-2', 'value-2');
            insertStmt.run('item-3', 'value-3');

            const stmt = db.prepare('SELECT * FROM test_items');
            const rows = stmt.all();

            expect(Array.isArray(rows)).toBe(true);
            expect(rows.length).toBe(3);
        });
    });

    describe('事务处理', () => {
        let db;

        beforeAll(async () => {
            const Database = (await import('better-sqlite3')).default;
            db = new Database(':memory:');

            db.exec(`
        CREATE TABLE IF NOT EXISTS tx_test (
          id INTEGER PRIMARY KEY,
          value TEXT
        )
      `);
        });

        afterAll(() => {
            if (db && db.open) {
                db.close();
            }
        });

        it('应该支持事务', () => {
            const insertMany = db.transaction((items) => {
                const stmt = db.prepare('INSERT INTO tx_test (value) VALUES (?)');
                for (const item of items) {
                    stmt.run(item);
                }
                return items.length;
            });

            const count = insertMany(['a', 'b', 'c', 'd', 'e']);
            expect(count).toBe(5);

            const rows = db.prepare('SELECT * FROM tx_test').all();
            expect(rows.length).toBe(5);
        });

        it('事务失败应该回滚', () => {
            const initialCount = db.prepare('SELECT COUNT(*) as count FROM tx_test').get().count;

            const badTransaction = db.transaction(() => {
                db.prepare('INSERT INTO tx_test (value) VALUES (?)').run('will-rollback');
                throw new Error('Intentional error');
            });

            expect(() => badTransaction()).toThrow('Intentional error');

            const finalCount = db.prepare('SELECT COUNT(*) as count FROM tx_test').get().count;
            expect(finalCount).toBe(initialCount); // 数量不变
        });
    });

    describe('Prepared Statements', () => {
        let db;

        beforeAll(async () => {
            const Database = (await import('better-sqlite3')).default;
            db = new Database(':memory:');

            db.exec(`
        CREATE TABLE ps_test (id INTEGER PRIMARY KEY, name TEXT)
      `);
        });

        afterAll(() => {
            if (db && db.open) db.close();
        });

        it('预编译语句应该能重复使用', () => {
            const stmt = db.prepare('INSERT INTO ps_test (name) VALUES (?)');

            for (let i = 0; i < 10; i++) {
                stmt.run(`item-${i}`);
            }

            const count = db.prepare('SELECT COUNT(*) as count FROM ps_test').get().count;
            expect(count).toBe(10);
        });

        it('命名参数应该正常工作', () => {
            const stmt = db.prepare('INSERT INTO ps_test (name) VALUES (@name)');
            stmt.run({ name: 'named-param-test' });

            const row = db.prepare('SELECT * FROM ps_test WHERE name = ?').get('named-param-test');
            expect(row).toBeDefined();
            expect(row.name).toBe('named-param-test');
        });
    });
});
