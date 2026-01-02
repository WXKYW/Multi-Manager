/**
 * AI Chat 模块 - API 路由
 */

const express = require('express');
const router = express.Router();
const { providerStorage, conversationStorage, messageStorage } = require('./storage');
const llmService = require('./service');
const { createLogger } = require('../../src/utils/logger');
const { requireAuth } = require('../../src/middleware/auth');

const logger = createLogger('AIChat');

// 所有路由都需要认证
router.use(requireAuth);

// ==================== Provider API ====================

/**
 * 获取所有 Provider
 */
router.get('/providers', (req, res) => {
    try {
        const providers = providerStorage.getAll();
        // 不返回 API Key 原文，仅返回是否已配置
        const safeProviders = providers.map(p => ({
            ...p,
            api_key: p.api_key ? '******' : '',
            hasKey: Boolean(p.api_key),
        }));
        res.json({ success: true, data: safeProviders });
    } catch (error) {
        logger.error('获取 Provider 列表失败:', error.message);
        res.status(500).json({ success: false, error: error.message });
    }
});

/**
 * 获取单个 Provider
 */
router.get('/providers/:id', (req, res) => {
    try {
        const provider = providerStorage.getById(req.params.id);
        if (!provider) {
            return res.status(404).json({ success: false, error: 'Provider 不存在' });
        }
        res.json({
            success: true,
            data: {
                ...provider,
                api_key: provider.api_key ? '******' : '',
                hasKey: Boolean(provider.api_key),
            },
        });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

/**
 * 创建/更新 Provider
 */
router.post('/providers', async (req, res) => {
    try {
        const data = req.body;
        if (!data.name) {
            return res.status(400).json({ success: false, error: '名称不能为空' });
        }

        const provider = providerStorage.save(data);
        logger.info(`Provider 已保存: ${provider.name} (${provider.id})`);
        res.json({ success: true, data: provider });
    } catch (error) {
        logger.error('保存 Provider 失败:', error.message);
        res.status(500).json({ success: false, error: error.message });
    }
});

/**
 * 删除 Provider
 */
router.delete('/providers/:id', (req, res) => {
    try {
        const deleted = providerStorage.delete(req.params.id);
        if (!deleted) {
            return res.status(404).json({ success: false, error: 'Provider 不存在' });
        }
        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

/**
 * 获取 Provider 可用模型
 */
router.get('/providers/:id/models', async (req, res) => {
    try {
        const provider = providerStorage.getById(req.params.id);
        if (!provider) {
            return res.status(404).json({ success: false, error: 'Provider 不存在' });
        }

        const models = await llmService.listModels(provider);

        // 更新 Provider 的模型列表缓存
        if (models.length > 0) {
            providerStorage.updateModels(provider.id, models);
        }

        res.json({ success: true, data: models });
    } catch (error) {
        logger.error('获取模型列表失败:', error.message);
        res.status(500).json({ success: false, error: error.message });
    }
});

/**
 * 验证 Provider 配置
 */
router.post('/providers/:id/validate', async (req, res) => {
    try {
        const provider = providerStorage.getById(req.params.id);
        if (!provider) {
            return res.status(404).json({ success: false, error: 'Provider 不存在' });
        }

        const result = await llmService.validateProvider(provider);
        res.json({ success: true, data: result });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// ==================== Conversation API ====================

/**
 * 获取所有对话
 */
router.get('/conversations', (req, res) => {
    try {
        const conversations = conversationStorage.getAll();
        res.json({ success: true, data: conversations });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

/**
 * 创建新对话
 */
router.post('/conversations', (req, res) => {
    try {
        const conversation = conversationStorage.create(req.body);
        logger.info(`新对话已创建: ${conversation.id}`);
        res.json({ success: true, data: conversation });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

/**
 * 更新对话
 */
router.put('/conversations/:id', (req, res) => {
    try {
        const conversation = conversationStorage.update(req.params.id, req.body);
        if (!conversation) {
            return res.status(404).json({ success: false, error: '对话不存在' });
        }
        res.json({ success: true, data: conversation });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

/**
 * 删除对话
 */
router.delete('/conversations/:id', (req, res) => {
    try {
        const deleted = conversationStorage.delete(req.params.id);
        if (!deleted) {
            return res.status(404).json({ success: false, error: '对话不存在' });
        }
        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

/**
 * 获取对话消息
 */
router.get('/conversations/:id/messages', (req, res) => {
    try {
        const messages = messageStorage.getByConversation(req.params.id);
        res.json({ success: true, data: messages });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// ==================== Chat API ====================

/**
 * 发送消息 (同步)
 */
router.post('/chat', async (req, res) => {
    try {
        const { conversation_id, provider_id, model, message, system_prompt } = req.body;

        if (!conversation_id || !provider_id || !message) {
            return res.status(400).json({ success: false, error: '缺少必要参数' });
        }

        const provider = providerStorage.getById(provider_id);
        if (!provider) {
            return res.status(404).json({ success: false, error: 'Provider 不存在' });
        }

        // 保存用户消息
        messageStorage.add({
            conversation_id,
            role: 'user',
            content: message,
        });

        // 构建消息上下文
        const context = messageStorage.getContext(conversation_id);
        if (system_prompt) {
            context.unshift({ role: 'system', content: system_prompt });
        }

        // 调用 LLM
        const result = await llmService.chat(provider, context, { model });

        // 保存 AI 响应
        const assistantMsg = messageStorage.add({
            conversation_id,
            role: 'assistant',
            content: result.content,
            token_count: result.usage?.total_tokens || 0,
        });

        // 自动设置对话标题
        const conv = conversationStorage.getById(conversation_id);
        if (conv && conv.title === '新对话') {
            conversationStorage.autoTitle(conversation_id);
        }

        res.json({
            success: true,
            data: {
                message: assistantMsg,
                usage: result.usage,
            },
        });
    } catch (error) {
        logger.error('聊天请求失败:', error.message);
        res.status(500).json({ success: false, error: error.message });
    }
});

/**
 * 发送消息 (SSE 流式)
 */
router.post('/chat/stream', async (req, res) => {
    const { conversation_id, provider_id, model, message, system_prompt } = req.body;

    if (!conversation_id || !provider_id || !message) {
        return res.status(400).json({ success: false, error: '缺少必要参数' });
    }

    const provider = providerStorage.getById(provider_id);
    if (!provider) {
        return res.status(404).json({ success: false, error: 'Provider 不存在' });
    }

    // 设置 SSE 响应头
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');

    try {
        // 保存用户消息
        const userMsg = messageStorage.add({
            conversation_id,
            role: 'user',
            content: message,
        });
        res.write(`data: ${JSON.stringify({ type: 'user_message', data: userMsg })}\n\n`);

        // 构建消息上下文
        const context = messageStorage.getContext(conversation_id);
        if (system_prompt) {
            context.unshift({ role: 'system', content: system_prompt });
        }

        // 创建助手消息占位符
        const assistantMsg = messageStorage.add({
            conversation_id,
            role: 'assistant',
            content: '',
        });
        res.write(`data: ${JSON.stringify({ type: 'assistant_start', data: { id: assistantMsg.id } })}\n\n`);

        // 流式调用 LLM
        let fullContent = '';
        for await (const chunk of llmService.chatStream(provider, context, { model })) {
            fullContent += chunk;
            res.write(`data: ${JSON.stringify({ type: 'chunk', data: chunk })}\n\n`);
        }

        // 更新完整消息
        messageStorage.update(assistantMsg.id, fullContent, 0);

        // 自动设置对话标题
        const conv = conversationStorage.getById(conversation_id);
        if (conv && conv.title === '新对话') {
            conversationStorage.autoTitle(conversation_id);
        }

        res.write(`data: ${JSON.stringify({ type: 'done', data: { content: fullContent } })}\n\n`);
        res.end();
    } catch (error) {
        logger.error('流式聊天失败:', error.message);
        res.write(`data: ${JSON.stringify({ type: 'error', data: error.message })}\n\n`);
        res.end();
    }
});

module.exports = router;
