const axios = require('axios');

async function testChat() {
    console.log('--- 对话功能测试 ---');
    try {
        const response = await axios.post('http://localhost:3000/api/antigravity/v1/chat/completions', {
            model: 'ag/rev19-uic3-1p',
            messages: [{ role: 'user', content: 'Hi' }],
            stream: false
        }, {
            headers: {
                'Authorization': 'Bearer 123456',
                'Content-Type': 'application/json'
            }
        });
        console.log('✅ 响应成功:', JSON.stringify(response.data, null, 2));
    } catch (error) {
        console.error('❌ 响应失败:', error.response?.status);
        console.error('错误详情:', JSON.stringify(error.response?.data, null, 2));
    }
}

testChat();
