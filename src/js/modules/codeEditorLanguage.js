import { LanguageDescription } from '@codemirror/language';
import { languages } from '@codemirror/language-data';
import { GFM } from '@lezer/markdown';

const LANGUAGE_ALIASES = {
  conf: 'properties',
  dockerfile: 'dockerfile',
  env: 'properties',
  hcl: 'terraform',
  html: 'html',
  ini: 'properties',
  js: 'javascript',
  jsx: 'jsx',
  md: 'markdown',
  ps1: 'powershell',
  py: 'python',
  sh: 'shell',
  shell: 'shell',
  text: '',
  ts: 'typescript',
  tsx: 'tsx',
  yml: 'yaml',
};

const markdownLanguage = LanguageDescription.of({
  name: 'Markdown',
  alias: ['md'],
  extensions: ['md', 'markdown', 'mkd'],
  load: () =>
    import('@codemirror/lang-markdown').then(({ markdown }) =>
      markdown({ codeLanguages: languages, extensions: GFM })
    ),
});

function withMarkdownCodeFences(description) {
  return description?.name === 'Markdown' ? markdownLanguage : description;
}

export function findCodeLanguage({ fileName = '', language = '' } = {}) {
  const requestedLanguage = String(language || '')
    .trim()
    .toLowerCase();
  const normalizedLanguage = LANGUAGE_ALIASES[requestedLanguage] ?? requestedLanguage;
  if (requestedLanguage && !normalizedLanguage) return null;

  if (normalizedLanguage) {
    return withMarkdownCodeFences(
      LanguageDescription.matchLanguageName(languages, normalizedLanguage, true)
    );
  }

  const normalizedFileName = String(fileName || '').trim();
  return withMarkdownCodeFences(
    normalizedFileName ? LanguageDescription.matchFilename(languages, normalizedFileName) : null
  );
}

export function getCodeLanguageName(options) {
  return findCodeLanguage(options)?.name || 'Plain Text';
}
