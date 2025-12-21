const client = require('./modules/antigravity-api/antigravity-client');
const storage = require('./modules/antigravity-api/storage');

async function diagnostic() {
    const accounts = storage.getAccounts().filter(a => a.enable);
    if (accounts.length === 0) {
        console.log('❌ 错误：没有启用的账号');
        return;
    }

    const acc = accounts[0];
    console.log(`使用账号测试: ${acc.name} (${acc.id})`);

    // 1. 测试额度获取 (验证 API 基础连通性)
    try {
        console.log('1. 测试额度查询...');
        const quotas = await client.listQuotas(acc.id);
        console.log('✅ 额度查询成功，API 连通性正常');
    } catch (e) {
        console.log('❌ 额度查询失败:', e.message);
    }

    // 2. 测试对话模型
    const testModels = ['rev19-uic3-1p', 'gemini-1.5-flash', 'gemini-2.0-flash-exp'];
    
    for (const modelId of testModels) {
        console.log(`
2. 测试模型对话: ${modelId}...`);
        try {
            const result = await client.chatCompletions(acc.id, {
                model: modelId,
                messages: [{ role: 'user', content: 'Hi' }]
            });
            console.log(`✅ [${modelId}] 对话成功:`, result.choices[0].message.content.substring(0, 50) + '...');
        } catch (e) {
            console.log(`❌ [${modelId}] 对话失败:`, e.message);
        }
    }
}

diagnostic();
