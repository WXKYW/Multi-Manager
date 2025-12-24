const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

// 配置
const DIST_DIR = path.join(__dirname, 'dist');

async function run() {
    console.log('🚀 开始构建 Agent (原生 pkg)...');

    // 1. 确保目录存在
    if (fs.existsSync(DIST_DIR)) {
        // 清理旧文件
        fs.rmSync(DIST_DIR, { recursive: true, force: true });
    }
    fs.mkdirSync(DIST_DIR, { recursive: true });

    // 2. 执行 pkg 打包
    console.log('🛠️ 正在使用 pkg 打包二进制文件...');
    try {
        // 安装依赖
        if (!fs.existsSync(path.join(__dirname, 'node_modules'))) {
            execSync('npm install', { cwd: __dirname, stdio: 'inherit' });
        }

        // 执行打包
        // 如果在 Dockerfile 中，targets 会通过参数传入，否则使用默认值
        const targets = process.env.PKG_TARGETS || 'node18-linux-x64,node18-win-x64';

        // 使用 --compress GZip 进行安全的资源压缩 (不会破坏二进制结构)
        execSync(`npx pkg . --out-path dist --targets ${targets} --compress GZip`, { cwd: __dirname, stdio: 'inherit' });
    } catch (e) {
        console.error('❌ 打包失败:', e.message);
        process.exit(1);
    }

    // 3. 复制到公共目录 (如果存在)
    const publicAgentDir = path.join(__dirname, '../public/agent');
    if (fs.existsSync(publicAgentDir)) {
        console.log('🚚 正在同步到 public/agent...');
        const files = fs.readdirSync(DIST_DIR).filter(f => !f.endsWith('.map'));
        for (const file of files) {
            fs.copyFileSync(path.join(DIST_DIR, file), path.join(publicAgentDir, file));
        }
    }

    console.log('\n✅ 所有任务完成！');
    console.log('-----------------------------------');
    const finalFiles = fs.readdirSync(DIST_DIR).filter(f => !f.endsWith('.map'));
    const stats = finalFiles.map(f => {
        const s = fs.statSync(path.join(DIST_DIR, f));
        return `${f}: ${(s.size / 1024 / 1024).toFixed(2)} MB`;
    });
    console.log('最终体积:\n' + stats.join('\n'));
}

run().catch(err => {
    console.error('💥 运行时错误:', err);
    process.exit(1);
});
