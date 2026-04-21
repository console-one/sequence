/**
 * extract.ts — Pull ft blocks from markdown files.
 *
 * Scans for ```ft fenced code blocks and returns their content.
 * Multiple blocks in one file are returned in order — they share scope.
 */

export type ExtractedBlock = {
  content: string;
  startLine: number;
  endLine: number;
};

/**
 * Extract all ```ft blocks from a markdown string.
 */
export function extractFtBlocks(markdown: string): ExtractedBlock[] {
  const blocks: ExtractedBlock[] = [];
  const lines = markdown.split('\n');
  let inBlock = false;
  let blockLines: string[] = [];
  let startLine = 0;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();

    if (!inBlock && (line === '```ft' || line === '``` ft')) {
      inBlock = true;
      blockLines = [];
      startLine = i + 1;
      continue;
    }

    if (inBlock && line === '```') {
      blocks.push({
        content: blockLines.join('\n'),
        startLine: startLine + 1, // 1-indexed
        endLine: i + 1,
      });
      inBlock = false;
      continue;
    }

    if (inBlock) {
      blockLines.push(lines[i]); // preserve original indentation
    }
  }

  return blocks;
}

/**
 * Extract and concatenate all ft blocks from a markdown file,
 * separated by newlines. Ready to feed to the parser.
 */
export function extractFt(markdown: string): string {
  return extractFtBlocks(markdown).map(b => b.content).join('\n');
}
