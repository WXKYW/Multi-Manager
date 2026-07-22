import { languages } from '@codemirror/language-data';
import { CrepeBuilder } from '@milkdown/crepe/builder';
import { blockEdit } from '@milkdown/crepe/feature/block-edit';
import { codeMirror } from '@milkdown/crepe/feature/code-mirror';
import { cursor } from '@milkdown/crepe/feature/cursor';
import { imageBlock } from '@milkdown/crepe/feature/image-block';
import { latex } from '@milkdown/crepe/feature/latex';
import { linkTooltip } from '@milkdown/crepe/feature/link-tooltip';
import { listItem } from '@milkdown/crepe/feature/list-item';
import { placeholder as placeholderFeature } from '@milkdown/crepe/feature/placeholder';
import { table } from '@milkdown/crepe/feature/table';
import { toolbar } from '@milkdown/crepe/feature/toolbar';

export function createMarkdownWysiwyg({ root, defaultValue, placeholder }) {
  return new CrepeBuilder({ root, defaultValue })
    .addFeature(cursor)
    .addFeature(listItem)
    .addFeature(linkTooltip)
    .addFeature(imageBlock)
    .addFeature(blockEdit)
    .addFeature(placeholderFeature, { text: placeholder })
    .addFeature(toolbar)
    .addFeature(codeMirror, { languages })
    .addFeature(table)
    .addFeature(latex);
}
