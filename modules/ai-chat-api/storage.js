/**
 * AI Chat 模块 - 存储层
 * 对 Models 的高级封装，提供业务逻辑相关的存储操作
 */

const { ProviderModel, ConversationModel, MessageModel } = require('./models');

/**
 * Provider 存储操作
 */
const providerStorage = {
    /**
     * 获取所有启用的 Provider
     */
    getEnabled() {
        return ProviderModel.getAll().filter(p => p.enabled);
    },

    /**
     * 获取所有 Provider
     */
    getAll() {
        return ProviderModel.getAll();
    },

    /**
     * 获取单个 Provider
     */
    getById(id) {
        return ProviderModel.getById(id);
    },

    /**
     * 创建或更新 Provider
     */
    save(data) {
        if (data.id) {
            const existing = ProviderModel.getById(data.id);
            if (existing) {
                return ProviderModel.update(data.id, data);
            }
        }
        return ProviderModel.create(data);
    },

    /**
     * 删除 Provider
     */
    delete(id) {
        return ProviderModel.delete(id);
    },

    /**
     * 更新 Provider 的模型列表
     */
    updateModels(id, models) {
        return ProviderModel.update(id, { models });
    },
};

/**
 * Conversation 存储操作
 */
const conversationStorage = {
    /**
     * 获取所有对话 (最近更新的在前)
     */
    getAll() {
        return ConversationModel.getAll();
    },

    /**
     * 获取单个对话
     */
    getById(id) {
        return ConversationModel.getById(id);
    },

    /**
     * 创建新对话
     */
    create(data = {}) {
        return ConversationModel.create(data);
    },

    /**
     * 更新对话
     */
    update(id, data) {
        return ConversationModel.update(id, data);
    },

    /**
     * 删除对话 (会级联删除消息)
     */
    delete(id) {
        // 先删除消息 (SQLite 外键约束会自动处理，但手动删除更可靠)
        MessageModel.deleteByConversation(id);
        return ConversationModel.delete(id);
    },

    /**
     * 自动设置对话标题 (基于第一条用户消息)
     */
    autoTitle(id) {
        const messages = MessageModel.getByConversation(id);
        const firstUserMsg = messages.find(m => m.role === 'user');
        if (firstUserMsg) {
            // 截取前 30 个字符作为标题
            const title = firstUserMsg.content.slice(0, 30).replace(/\n/g, ' ');
            return ConversationModel.update(id, { title: title + (firstUserMsg.content.length > 30 ? '...' : '') });
        }
        return ConversationModel.getById(id);
    },
};

/**
 * Message 存储操作
 */
const messageStorage = {
    /**
     * 获取对话的所有消息
     */
    getByConversation(conversationId) {
        return MessageModel.getByConversation(conversationId);
    },

    /**
     * 添加消息
     */
    add(data) {
        return MessageModel.create(data);
    },

    /**
     * 更新消息 (用于流式响应累积)
     */
    update(id, content, tokenCount) {
        return MessageModel.update(id, content, tokenCount);
    },

    /**
     * 删除消息
     */
    delete(id) {
        return MessageModel.delete(id);
    },

    /**
     * 获取对话的上下文消息 (用于发送给 LLM)
     */
    getContext(conversationId, maxMessages = 20) {
        const messages = MessageModel.getByConversation(conversationId);
        // 只保留最近的 N 条消息
        const recent = messages.slice(-maxMessages);
        // 转换为 OpenAI 格式
        return recent.map(m => ({
            role: m.role,
            content: m.content,
        }));
    },
};

module.exports = {
    providerStorage,
    conversationStorage,
    messageStorage,
};
