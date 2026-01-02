/**
 * AI Chat 模块 - 数据模型层
 * 定义数据库操作接口
 */

const db = require('../../src/db/database');

/**
 * 生成唯一 ID
 */
function generateId(prefix = 'ac') {
    return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * Provider 模型
 */
const ProviderModel = {
    tableName: 'ai_chat_providers',

    /**
     * 获取所有 Provider
     */
    getAll() {
        const stmt = db.prepare(`SELECT * FROM ${this.tableName} ORDER BY sort_order, created_at`);
        const rows = stmt.all();
        return rows.map(row => ({
            ...row,
            models: row.models ? JSON.parse(row.models) : [],
            enabled: Boolean(row.enabled),
        }));
    },

    /**
     * 根据 ID 获取 Provider
     */
    getById(id) {
        const stmt = db.prepare(`SELECT * FROM ${this.tableName} WHERE id = ?`);
        const row = stmt.get(id);
        if (!row) return null;
        return {
            ...row,
            models: row.models ? JSON.parse(row.models) : [],
            enabled: Boolean(row.enabled),
        };
    },

    /**
     * 创建 Provider
     */
    create(data) {
        const id = generateId('provider');
        const stmt = db.prepare(`
      INSERT INTO ${this.tableName} (id, name, type, base_url, api_key, default_model, models, enabled, sort_order)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
        stmt.run(
            id,
            data.name,
            data.type || 'openai',
            data.base_url || 'https://api.openai.com/v1',
            data.api_key || '',
            data.default_model || 'gpt-3.5-turbo',
            JSON.stringify(data.models || []),
            data.enabled !== false ? 1 : 0,
            data.sort_order || 0
        );
        return this.getById(id);
    },

    /**
     * 更新 Provider
     */
    update(id, data) {
        const fields = [];
        const values = [];

        if (data.name !== undefined) { fields.push('name = ?'); values.push(data.name); }
        if (data.type !== undefined) { fields.push('type = ?'); values.push(data.type); }
        if (data.base_url !== undefined) { fields.push('base_url = ?'); values.push(data.base_url); }
        if (data.api_key !== undefined) { fields.push('api_key = ?'); values.push(data.api_key); }
        if (data.default_model !== undefined) { fields.push('default_model = ?'); values.push(data.default_model); }
        if (data.models !== undefined) { fields.push('models = ?'); values.push(JSON.stringify(data.models)); }
        if (data.enabled !== undefined) { fields.push('enabled = ?'); values.push(data.enabled ? 1 : 0); }
        if (data.sort_order !== undefined) { fields.push('sort_order = ?'); values.push(data.sort_order); }

        if (fields.length === 0) return this.getById(id);

        fields.push("updated_at = datetime('now', 'localtime')");
        values.push(id);

        const stmt = db.prepare(`UPDATE ${this.tableName} SET ${fields.join(', ')} WHERE id = ?`);
        stmt.run(...values);
        return this.getById(id);
    },

    /**
     * 删除 Provider
     */
    delete(id) {
        const stmt = db.prepare(`DELETE FROM ${this.tableName} WHERE id = ?`);
        const result = stmt.run(id);
        return result.changes > 0;
    },
};

/**
 * Conversation 模型
 */
const ConversationModel = {
    tableName: 'ai_chat_conversations',

    /**
     * 获取所有对话
     */
    getAll() {
        const stmt = db.prepare(`SELECT * FROM ${this.tableName} ORDER BY updated_at DESC`);
        return stmt.all();
    },

    /**
     * 根据 ID 获取对话
     */
    getById(id) {
        const stmt = db.prepare(`SELECT * FROM ${this.tableName} WHERE id = ?`);
        return stmt.get(id);
    },

    /**
     * 创建对话
     */
    create(data = {}) {
        const id = generateId('conv');
        const stmt = db.prepare(`
      INSERT INTO ${this.tableName} (id, title, provider_id, model, system_prompt, temperature, max_tokens)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);
        stmt.run(
            id,
            data.title || '新对话',
            data.provider_id || null,
            data.model || null,
            data.system_prompt || null,
            data.temperature ?? 0.7,
            data.max_tokens ?? 4096
        );
        return this.getById(id);
    },

    /**
     * 更新对话
     */
    update(id, data) {
        const fields = [];
        const values = [];

        if (data.title !== undefined) { fields.push('title = ?'); values.push(data.title); }
        if (data.provider_id !== undefined) { fields.push('provider_id = ?'); values.push(data.provider_id); }
        if (data.model !== undefined) { fields.push('model = ?'); values.push(data.model); }
        if (data.system_prompt !== undefined) { fields.push('system_prompt = ?'); values.push(data.system_prompt); }
        if (data.temperature !== undefined) { fields.push('temperature = ?'); values.push(data.temperature); }
        if (data.max_tokens !== undefined) { fields.push('max_tokens = ?'); values.push(data.max_tokens); }

        if (fields.length === 0) return this.getById(id);

        fields.push("updated_at = datetime('now', 'localtime')");
        values.push(id);

        const stmt = db.prepare(`UPDATE ${this.tableName} SET ${fields.join(', ')} WHERE id = ?`);
        stmt.run(...values);
        return this.getById(id);
    },

    /**
     * 删除对话
     */
    delete(id) {
        const stmt = db.prepare(`DELETE FROM ${this.tableName} WHERE id = ?`);
        const result = stmt.run(id);
        return result.changes > 0;
    },

    /**
     * 更新最后修改时间 (用于对话排序)
     */
    touch(id) {
        const stmt = db.prepare(`UPDATE ${this.tableName} SET updated_at = datetime('now', 'localtime') WHERE id = ?`);
        stmt.run(id);
    },
};

/**
 * Message 模型
 */
const MessageModel = {
    tableName: 'ai_chat_messages',

    /**
     * 获取对话的所有消息
     */
    getByConversation(conversationId) {
        const stmt = db.prepare(`SELECT * FROM ${this.tableName} WHERE conversation_id = ? ORDER BY created_at`);
        return stmt.all(conversationId);
    },

    /**
     * 创建消息
     */
    create(data) {
        const id = generateId('msg');
        const stmt = db.prepare(`
      INSERT INTO ${this.tableName} (id, conversation_id, role, content, token_count)
      VALUES (?, ?, ?, ?, ?)
    `);
        stmt.run(
            id,
            data.conversation_id,
            data.role,
            data.content,
            data.token_count || 0
        );

        // 更新对话的最后修改时间
        ConversationModel.touch(data.conversation_id);

        return { id, ...data };
    },

    /**
     * 更新消息内容 (用于流式响应)
     */
    update(id, content, tokenCount) {
        const stmt = db.prepare(`UPDATE ${this.tableName} SET content = ?, token_count = ? WHERE id = ?`);
        stmt.run(content, tokenCount || 0, id);
    },

    /**
     * 删除消息
     */
    delete(id) {
        const stmt = db.prepare(`DELETE FROM ${this.tableName} WHERE id = ?`);
        const result = stmt.run(id);
        return result.changes > 0;
    },

    /**
     * 删除对话的所有消息
     */
    deleteByConversation(conversationId) {
        const stmt = db.prepare(`DELETE FROM ${this.tableName} WHERE conversation_id = ?`);
        stmt.run(conversationId);
    },
};

module.exports = {
    ProviderModel,
    ConversationModel,
    MessageModel,
    generateId,
};
