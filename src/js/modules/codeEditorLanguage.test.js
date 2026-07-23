import { describe, expect, it } from 'vitest';
import { findCodeLanguage, getCodeLanguageName } from './codeEditorLanguage.js';

describe('code editor language detection', () => {
  it.each([
    ['Dockerfile', 'Dockerfile'],
    ['settings.json', 'JSON'],
    ['compose.yaml', 'YAML'],
    ['script.ps1', 'PowerShell'],
    ['main.go', 'Go'],
    ['notes.md', 'Markdown'],
  ])('detects %s as %s', (fileName, expected) => {
    expect(getCodeLanguageName({ fileName })).toBe(expected);
  });

  it('supports explicit aliases and plain text', () => {
    expect(getCodeLanguageName({ language: 'sh' })).toBe('Shell');
    expect(getCodeLanguageName({ fileName: 'data.json', language: 'text' })).toBe('Plain Text');
  });

  it('enables GFM syntax for Markdown files', async () => {
    const support = await findCodeLanguage({ fileName: 'README.md' }).load();
    const tree = support.language.parser.parse('| Name |\n| --- |\n| API Monitor |');

    expect(tree.toString()).toContain('Table');
  });
});
