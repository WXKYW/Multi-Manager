/**
 * AI Chat 模块 - LLM API 服务层
 * 封装与各种 LLM API 的交互
 */

const { createLogger } = require('../../src/utils/logger');
const logger = createLogger('AIChatService');

/**
 * 发送聊天请求 (同步)
 * @param {Object} provider - Provider 配置
 * @param {Array} messages - 消息数组 [{role, content}]
 * @param {Object} options - 选项 {model, temperature, max_tokens}
 * @returns {Promise<Object>} - 响应结果
 */
async function chat(provider, messages, options = {}) {
    const model = options.model || provider.default_model || 'gpt-3.5-turbo';
    const temperature = options.temperature ?? 0.7;
    const maxTokens = options.max_tokens ?? 4096;

    const url = `${provider.base_url}/chat/completions`;

    const response = await fetch(url, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${provider.api_key}`,
        },
        body: JSON.stringify({
            model,
            messages,
            temperature,
            max_tokens: maxTokens,
            stream: false,
        }),
    });

    if (!response.ok) {
        const error = await response.json().catch(() => ({}));
        throw new Error(error.error?.message || `API 请求失败: ${response.status}`);
    }

    const data = await response.json();
    return {
        content: data.choices?.[0]?.message?.content || '',
        usage: data.usage || {},
        model: data.model,
        finish_reason: data.choices?.[0]?.finish_reason,
    };
}

/**
 * 发送聊天请求 (SSE 流式)
 * @param {Object} provider - Provider 配置
 * @param {Array} messages - 消息数组 [{role, content}]
 * @param {Object} options - 选项 {model, temperature, max_tokens}
 * @returns {AsyncGenerator<string>} - 流式内容生成器
 */
async function* chatStream(provider, messages, options = {}) {
    const model = options.model || provider.default_model || 'gpt-3.5-turbo';
    const temperature = options.temperature ?? 0.7;
    const maxTokens = options.max_tokens ?? 4096;

    const url = `${provider.base_url}/chat/completions`;

    const response = await fetch(url, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${provider.api_key}`,
        },
        body: JSON.stringify({
            model,
            messages,
            temperature,
            max_tokens: maxTokens,
            stream: true,
        }),
    });

    if (!response.ok) {
        const error = await response.json().catch(() => ({}));
        throw new Error(error.error?.message || `API 请求失败: ${response.status}`);
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    try {
        while (true) {
            const { done, value } = await reader.read();
            if (done) break;

            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split('\n');
            buffer = lines.pop() || '';

            for (const line of lines) {
                const trimmed = line.trim();
                if (!trimmed || !trimmed.startsWith('data: ')) continue;

                const data = trimmed.slice(6);
                if (data === '[DONE]') return;

                try {
                    const json = JSON.parse(data);
                    const content = json.choices?.[0]?.delta?.content;
                    if (content) {
                        yield content;
                    }
                } catch (e) {
                    // 忽略解析错误
                }
            }
        }
    } finally {
        reader.releaseLock();
    }
}

/**
 * 获取 Provider 可用模型列表
 * @param {Object} provider - Provider 配置
 * @returns {Promise<Array>} - 模型列表
 */
async function listModels(provider) {
    const url = `${provider.base_url}/models`;

    try {
        const response = await fetch(url, {
            method: 'GET',
            headers: {
                'Authorization': `Bearer ${provider.api_key}`,
            },
        });

        if (!response.ok) {
            logger.warn(`获取模型列表失败: ${response.status}`);
            return [];
        }

        const data = await response.json();

        // 过滤出聊天模型
        const models = (data.data || [])
            .filter(m => {
                const id = m.id.toLowerCase();
                return id.includes('gpt') || id.includes('claude') || id.includes('gemini') ||
                    id.includes('chat') || id.includes('llama') || id.includes('qwen') ||
                    id.includes('deepseek') || id.includes('mistral');
            })
            .map(m => ({
                id: m.id,
                name: m.id,
                created: m.created,
            }))
            .sort((a, b) => a.name.localeCompare(b.name));

        return models;
    } catch (error) {
        logger.error('获取模型列表异常:', error.message);
        return [];
    }
}

/**
 * 验证 Provider 配置是否有效
 * @param {Object} provider - Provider 配置
 * @returns {Promise<Object>} - {valid: boolean, error?: string}
 */
async function validateProvider(provider) {
    try {
        const models = await listModels(provider);
        if (models.length > 0) {
            return { valid: true, models };
        }

        // 如果获取模型列表失败，尝试发送一个简单请求验证
        const result = await chat(provider, [{ role: 'user', content: 'Hi' }], { max_tokens: 5 });
        return { valid: true, test: result.content };
    } catch (error) {
        return { valid: false, error: error.message };
    }
}

module.exports = {
    chat,
    chatStream,
    listModels,
    validateProvider,
};
