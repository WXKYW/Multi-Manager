const Database = require('better-sqlite3');
const db = new Database('data/data.db');
const storage = require('./modules/antigravity-api/storage');
const service = require('./modules/antigravity-api/antigravity-service');

const modelConfigs = storage.getModelConfigs();
console.log('--- DB ModelConfigs ---');
console.log(modelConfigs);

const matrix = service.getMatrixConfig();
console.log('--- Matrix Keys ---');
console.log(Object.keys(matrix));

const models = service.getAvailableModels('');
console.log('--- Final Result Count ---');
console.log(models.length);
db.close();
