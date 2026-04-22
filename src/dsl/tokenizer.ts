/**
 * tokenizer.ts — Lexer for the behavioral type DSL.
 *
 * Produces a flat token stream from an ft block string.
 * The parser (parser.ts) consumes this stream.
 */

export type TokenKind =
  // Structural
  | 'LBRACE' | 'RBRACE' | 'LPAREN' | 'RPAREN' | 'LBRACKET' | 'RBRACKET'
  | 'COMMA' | 'COLON' | 'SEMICOLON' | 'DOT' | 'QUESTION'
  // Operators
  | 'ASSIGN'     // =
  | 'NARROW'     // <<
  | 'PIPE'       // |  (refinement or union depending on context)
  | 'AMPERSAND'  // &  (intersection)
  | 'ARROW'      // ->
  | 'AT'         // @
  | 'TILDE'      // ~
  | 'DOTDOT'     // ..
  | 'SPREAD'     // ...
  // Comparison
  | 'LT' | 'LTE' | 'GT' | 'GTE' | 'NEQ'
  | 'PLUS' | 'MINUS' | 'STAR' | 'SLASH'
  // Keywords
  | 'TYPE' | 'DELETE' | 'CAP' | 'POLICY'
  | 'WHEN' | 'WHILE' | 'WHERE' | 'ONBREAK' | 'BY'
  | 'EXISTS' | 'NOT'
  | 'MATCHES' | 'HAS' | 'IN' | 'SATISFIES'
  | 'FORALL'
  | 'PRESERVES'
  | 'IMPORT' | 'FROM' | 'EXPORT'
  | 'LET' | 'REF' | 'SNAPSHOT' | 'PREV'
  | 'CLASS'
  | 'INDEX' | 'OVER'
  | 'READER'
  // Literals
  | 'STRING' | 'NUMBER' | 'TRUE' | 'FALSE' | 'NULL'
  | 'REGEX'      // /pattern/
  // Identifiers
  | 'IDENT'      // plain identifier
  | 'VARIABLE'   // $name (bound variable)
  // Special
  | 'EXPANSION'  // [[ label : description ]] — stub/gap
  | 'COMMENT'    // -- comment
  | 'EOF'
  ;

export type Token = {
  kind: TokenKind;
  value: string;
  line: number;
  col: number;
};

const KEYWORDS: Record<string, TokenKind> = {
  'type': 'TYPE', 'delete': 'DELETE', 'tool': 'CAP', 'policy': 'POLICY',
  'when': 'WHEN', 'while': 'WHILE', 'where': 'WHERE', 'onBreak': 'ONBREAK', 'by': 'BY',
  'EXISTS': 'EXISTS', 'exists': 'EXISTS', 'NOT': 'NOT', 'not': 'NOT',
  'MATCHES': 'MATCHES', 'HAS': 'HAS', 'IN': 'IN', 'in': 'IN', 'SATISFIES': 'SATISFIES',
  'forall': 'FORALL',
  'preserves': 'PRESERVES',
  'import': 'IMPORT', 'from': 'FROM', 'export': 'EXPORT',
  'let': 'LET', 'ref': 'REF', 'snapshot': 'SNAPSHOT', 'prev': 'PREV',
  'class': 'CLASS',
  'index': 'INDEX', 'over': 'OVER',
  'reader': 'READER',
  'true': 'TRUE', 'false': 'FALSE', 'null': 'NULL',
  'string': 'IDENT', 'number': 'IDENT', 'boolean': 'IDENT',
};

export function tokenize(source: string): Token[] {
  const tokens: Token[] = [];
  let pos = 0;
  let line = 1;
  let col = 1;

  const peek = () => pos < source.length ? source[pos] : '';
  const advance = () => {
    const ch = source[pos++];
    if (ch === '\n') { line++; col = 1; } else { col++; }
    return ch;
  };
  const emit = (kind: TokenKind, value: string, startLine: number, startCol: number) => {
    tokens.push({ kind, value, line: startLine, col: startCol });
  };

  while (pos < source.length) {
    const startLine = line;
    const startCol = col;
    const ch = peek();

    // Whitespace
    if (ch === ' ' || ch === '\t' || ch === '\r' || ch === '\n') { advance(); continue; }

    // Comment: -- to end of line (preserved as tokens — comments are narrative context)
    if (ch === '-' && pos + 1 < source.length && source[pos + 1] === '-') {
      advance(); advance(); // skip --
      let comment = '';
      while (pos < source.length && peek() !== '\n') comment += advance();
      emit('COMMENT', comment.trim(), startLine, startCol);
      continue;
    }

    // Expansion token: [[ ... ]]
    if (ch === '[' && pos + 1 < source.length && source[pos + 1] === '[') {
      advance(); advance(); // skip [[
      let content = '';
      while (pos < source.length && !(peek() === ']' && pos + 1 < source.length && source[pos + 1] === ']')) {
        content += advance();
      }
      if (pos < source.length) { advance(); advance(); } // skip ]]
      emit('EXPANSION', content.trim(), startLine, startCol);
      continue;
    }

    // Two-char operators
    if (ch === '<' && pos + 1 < source.length && source[pos + 1] === '<') { advance(); advance(); emit('NARROW', '<<', startLine, startCol); continue; }
    if (ch === '<' && pos + 1 < source.length && source[pos + 1] === '=') { advance(); advance(); emit('LTE', '<=', startLine, startCol); continue; }
    if (ch === '>' && pos + 1 < source.length && source[pos + 1] === '=') { advance(); advance(); emit('GTE', '>=', startLine, startCol); continue; }
    if (ch === '!' && pos + 1 < source.length && source[pos + 1] === '=') { advance(); advance(); emit('NEQ', '!=', startLine, startCol); continue; }
    if (ch === '-' && pos + 1 < source.length && source[pos + 1] === '>') { advance(); advance(); emit('ARROW', '->', startLine, startCol); continue; }
    if (ch === '.' && pos + 1 < source.length && source[pos + 1] === '.' && pos + 2 < source.length && source[pos + 2] === '.') { advance(); advance(); advance(); emit('SPREAD', '...', startLine, startCol); continue; }
    if (ch === '.' && pos + 1 < source.length && source[pos + 1] === '.') { advance(); advance(); emit('DOTDOT', '..', startLine, startCol); continue; }

    // Single-char operators
    if (ch === '{') { advance(); emit('LBRACE', '{', startLine, startCol); continue; }
    if (ch === '}') { advance(); emit('RBRACE', '}', startLine, startCol); continue; }
    if (ch === '(') { advance(); emit('LPAREN', '(', startLine, startCol); continue; }
    if (ch === ')') { advance(); emit('RPAREN', ')', startLine, startCol); continue; }
    if (ch === '[') { advance(); emit('LBRACKET', '[', startLine, startCol); continue; }
    if (ch === ']') { advance(); emit('RBRACKET', ']', startLine, startCol); continue; }
    if (ch === ',') { advance(); emit('COMMA', ',', startLine, startCol); continue; }
    if (ch === ':') { advance(); emit('COLON', ':', startLine, startCol); continue; }
    if (ch === ';') { advance(); emit('SEMICOLON', ';', startLine, startCol); continue; }
    if (ch === '.') { advance(); emit('DOT', '.', startLine, startCol); continue; }
    if (ch === '?') { advance(); emit('QUESTION', '?', startLine, startCol); continue; }
    if (ch === '=') { advance(); emit('ASSIGN', '=', startLine, startCol); continue; }
    if (ch === '|') { advance(); emit('PIPE', '|', startLine, startCol); continue; }
    if (ch === '&') { advance(); emit('AMPERSAND', '&', startLine, startCol); continue; }
    if (ch === '@') { advance(); emit('AT', '@', startLine, startCol); continue; }
    if (ch === '~') { advance(); emit('TILDE', '~', startLine, startCol); continue; }
    if (ch === '<') { advance(); emit('LT', '<', startLine, startCol); continue; }
    if (ch === '>') { advance(); emit('GT', '>', startLine, startCol); continue; }
    if (ch === '+') { advance(); emit('PLUS', '+', startLine, startCol); continue; }
    if (ch === '*') { advance(); emit('STAR', '*', startLine, startCol); continue; }

    // Minus (not comment, not arrow)
    if (ch === '-') { advance(); emit('MINUS', '-', startLine, startCol); continue; }

    // Regex: /pattern/
    if (ch === '/') {
      advance(); // skip opening /
      let pattern = '';
      while (pos < source.length && peek() !== '/') pattern += advance();
      if (pos < source.length) advance(); // skip closing /
      emit('REGEX', pattern, startLine, startCol);
      continue;
    }

    // String: "..." or '...'
    if (ch === '"' || ch === "'") {
      const quote = advance();
      let str = '';
      while (pos < source.length && peek() !== quote) {
        if (peek() === '\\') {
          advance();
          const esc = advance();
          // Standard escape sequences. Without this, `\n` (backslash-n)
          // in source becomes literal 'n' in the string — every typed
          // newline that round-tripped through ft text would lose its
          // newline-ness and inject an 'n' instead.
          switch (esc) {
            case 'n': str += '\n'; break;
            case 't': str += '\t'; break;
            case 'r': str += '\r'; break;
            case '\\': str += '\\'; break;
            case '"': str += '"'; break;
            case "'": str += "'"; break;
            default: str += esc; break;
          }
        }
        else str += advance();
      }
      if (pos < source.length) advance(); // skip closing quote
      emit('STRING', str, startLine, startCol);
      continue;
    }

    // Number — careful not to consume '..' range operator
    if (ch >= '0' && ch <= '9') {
      let num = '';
      while (pos < source.length && peek() >= '0' && peek() <= '9') num += advance();
      // Only consume decimal point if followed by a digit (not '..' range)
      if (pos < source.length && peek() === '.' && pos + 1 < source.length && source[pos + 1] >= '0' && source[pos + 1] <= '9') {
        num += advance(); // consume '.'
        while (pos < source.length && peek() >= '0' && peek() <= '9') num += advance();
      }
      emit('NUMBER', num, startLine, startCol);
      continue;
    }

    // Variable: $name
    if (ch === '$') {
      advance(); // skip $
      let name = '';
      while (pos < source.length && /[a-zA-Z0-9_]/.test(peek())) name += advance();
      emit('VARIABLE', name, startLine, startCol);
      continue;
    }

    // Identifier or keyword
    if (/[a-zA-Z_]/.test(ch)) {
      let ident = '';
      while (pos < source.length && /[a-zA-Z0-9_]/.test(peek())) ident += advance();
      const keyword = KEYWORDS[ident];
      if (keyword && keyword !== 'IDENT') emit(keyword, ident, startLine, startCol);
      else emit('IDENT', ident, startLine, startCol);
      continue;
    }

    // Unknown character — skip
    advance();
  }

  emit('EOF', '', line, col);
  return tokens;
}
