const dbService = require('./src/db/database');
dbService.initialize();
const db = dbService.getDatabase();

try {
    const tokens = db.prepare('SELECT account_id, project_id, email, enable FROM antigravity_tokens').all();
    console.log('--- Antigravity Tokens ---');
    console.table(tokens);
} catch (e) {
    console.error('Error:', e.message);
}
