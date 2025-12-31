/**
 * Commitlint 配置
 * 强制使用 Conventional Commits 格式
 *
 * 格式: <type>(<scope>): <subject>
 *
 * 类型 (type):
 *   feat     - 新功能
 *   fix      - 修复 bug
 *   docs     - 文档更新
 *   style    - 代码格式 (不影响逻辑)
 *   refactor - 重构
 *   perf     - 性能优化
 *   test     - 测试相关
 *   build    - 构建/依赖更新
 *   ci       - CI 配置
 *   chore    - 杂项
 *   revert   - 回滚
 *
 * 示例:
 *   feat(auth): add OAuth2 support
 *   fix(api): handle null response
 *   docs: update README
 */
export default {
  extends: ['@commitlint/config-conventional'],
  rules: {
    // 类型必须是以下之一
    'type-enum': [
      2,
      'always',
      [
        'feat', // 新功能
        'fix', // 修复
        'docs', // 文档
        'style', // 格式
        'refactor', // 重构
        'perf', // 性能
        'test', // 测试
        'build', // 构建
        'ci', // CI
        'chore', // 杂项
        'revert', // 回滚
      ],
    ],
    // 类型小写
    'type-case': [2, 'always', 'lower-case'],
    // 必须有类型
    'type-empty': [2, 'never'],
    // 主题不能为空
    'subject-empty': [2, 'never'],
    // 主题最大长度
    'subject-max-length': [2, 'always', 72],
    // 主题不以句号结尾
    'subject-full-stop': [2, 'never', '.'],
    // Header 最大长度
    'header-max-length': [2, 'always', 100],
  },
};
