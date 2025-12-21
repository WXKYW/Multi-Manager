const service = require('./modules/antigravity-api/antigravity-service');
const storage = require('./modules/antigravity-api/storage');

const prefix = '[ag]';
try {
    const models = service.getAvailableModels(prefix);
    const ids = models.map(m => m.id);
    console.log('--- GENERATED MODELS ---');
    console.log(JSON.stringify(ids, null, 2));
    console.log('Total count:', ids.length);
} catch (e) {
    console.error(e);
}
