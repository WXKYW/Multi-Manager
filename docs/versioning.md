# 版本管理

API Monitor 使用语义化版本（Semantic Versioning），格式为 `MAJOR.MINOR.PATCH`。

## 版本来源

- `package.json` 中的 `version` 是正式版本的单一来源。
- GitHub Release 和 Git tag 使用相同版本，并增加 `v` 前缀，例如 `v2.0.1`。
- `main` 构建显示正式版本，例如 `v2.0.1`。
- `dev` 和其他开发分支显示 `dev-xxxx`，其中 `xxxx` 是完整提交哈希的末四位。
- Docker 构建通过 `APP_VERSION` 构建参数把版本写入前端，不在运行时请求 GitHub。

## 日常发布流程

1. 在 `dev` 完成功能开发和验证。
2. 使用 merge commit 将 `dev` 合并到 `main`，不要使用 squash merge。
3. `Bump Main Version` 工作流比较合并前后的版本：
   - 版本未变化时，自动执行 patch 递增，例如 `2.0.0` 到 `2.0.1`。
   - 版本已人工提升到更高的 minor 或 major 时，保留人工版本。
4. 工作流提交 `package.json` 和 `package-lock.json`，随后重新触发主分支 CI/CD。
5. 创建 Release 时，输入版本必须与 `package.json` 一致；不一致时工作流会停止。

## 主版本和次版本

需要不兼容更新或较大功能版本时，在合并到 `main` 前运行：

```bash
npm run version:major
npm run version:minor
```

普通修复版本通常不需要手动执行；主分支合并工作流会自动处理。需要本地手动递增 patch 时可运行：

```bash
npm run version:patch
```

版本修改应与对应功能一起提交，不要单独修改 Git tag 来代替源代码版本。
