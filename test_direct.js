const client = require('./modules/antigravity-api/antigravity-client');
const storage = require('./modules/antigravity-api/storage');

async function testDirect() {
    const accounts = storage.getAccounts().filter(a => a.enable);
    if (accounts.length === 0) {
        console.error('No enabled accounts found');
        return;
    }

    const acc = accounts[0];
    console.log(`Testing account: ${acc.name} (${acc.id})`);

    try {
        console.log('1. Trying to list quotas...');
        const quotas = await client.listQuotas(acc.id);
        console.log('✅ Quotas fetched successfully');
        
        console.log('2. Trying a simple chat completion...');
        const result = await client.chatCompletions(acc.id, {
            model: 'gemini-1.5-flash',
            messages: [{ role: 'user', content: 'Hi' }]
        });
        console.log('✅ Chat success:', result.choices[0].message.content);
    } catch (e) {
        console.error('❌ Failed:', e.message);
    }
}

testDirect();
