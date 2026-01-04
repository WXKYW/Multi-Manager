const db = require('./src/db/database');
const fs = require('fs');

try {
    console.log('正在分析数据库中的消息大小...');
    const database = db.getDatabase();

    // 获取最近的 20 条消息
    const messages = database.prepare(`
    SELECT id, role, length(content) as len, substr(content, 1, 100) as preview 
    FROM chat_messages 
    ORDER BY id DESC 
    LIMIT 20
  `).all();

    console.log('ID\t| Role\t| Size(KB)\t| Preview');
    console.log('----------------------------------------------------');

    let base64Count = 0;

    messages.forEach(msg => {
        const sizeKB = (msg.len / 1024).toFixed(2);
        const isBase64 = msg.preview.includes('data:image') || msg.preview.includes('base64');
        if (isBase64 && msg.len > 1000) base64Count++;

        // 简单的颜色标记
        const mark = (msg.len > 10240) ? '(!)' : '   ';

        console.log(`${msg.id}\t| ${msg.role}\t| ${sizeKB} KB${mark}\t| ${msg.preview.replace(/\n/g, ' ')}...`);
    });

    console.log('----------------------------------------------------');
    console.log(`分析完成。在大约最后 20 条消息中，发现 ${base64Count} 条疑似 Base64 图片记录。`);

    if (base64Count > 0) {
        console.log('建议：这证实了数据库中确实存储了 Base64 数据。');
    } else {
        console.log('提示：最近的消息似乎没有巨大的 Base64 数据。可能之前的记录导致了数据库膨胀。');
    }

} catch (e) {
    console.error('分析失败:', e);
}
