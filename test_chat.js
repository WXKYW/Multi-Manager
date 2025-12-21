const axios = require('axios');

async function testChat() {
    try {
        const response = await axios.post('http://localhost:3000/v1/chat/completions', {
            model: '假流式/gemini-3-flash',
            messages: [{ role: 'user', content: '你好，请回复"连接正常"' }],
            stream: false
        }, {
            headers: {
                'Authorization': 'Bearer 123456',
                'Content-Type': 'application/json'
            },
            timeout: 30000
        });

        console.log('--- API RESPONSE ---');
        console.log(JSON.stringify(response.data, null, 2));
    } catch (error) {
        console.error('--- ERROR ---');
        if (error.response) {
            console.error('Status:', error.response.status);
            console.error('Data:', JSON.stringify(error.response.data, null, 2));
        } else {
            console.error(error.message);
        }
    }
}

testChat();
