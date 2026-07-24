/**
 * parser.ts — Recursive descent parser for the behavioral type DSL.
 *
 * Consumes a token stream (from tokenizer.ts) and produces an AST (from ast.ts).
 * The parser handles: =, <<, blocks with import/export, type expressions,
 * refinement predicates, modifiers (when/while/onBreak/by), and all operators.
 */

import { tokenize, type Token, type TokenKind } from './tokenizer';
import {
  type Statement, type Expr, type Modifiers, type Predicate,
  type ComparisonPredicate, type ConditionExpr, type PrimitiveConstraint,
  type AssignStatement, type NarrowStatement,
} from './ast';

export class Parser {
  private tokens: Token[];
  private pos = 0;

  constructor(tokens: Token[]) {
    this.tokens = tokens;
  }

  // ═══ TOKEN NAVIGATION ════════════════════════════════════════════════

  private peek(): Token { return this.tokens[this.pos] ?? { kind: 'EOF', value: '', line: 0, col: 0 }; }

  /**
   * Consume any token whose `.value` looks like an identifier
   * (matches `[a-zA-Z_]\w*`). Used in places where common words
   * like `policy`, `type`, `tool`, `user` — which the tokenizer
   * maps to keyword kinds — should still be usable as plain
   * identifiers (e.g. class index variable names).
   */
  private expectIdentLike(): Token {
    const t = this.peek();
    if (t.kind === 'IDENT' || /^[a-zA-Z_]\w*$/.test(t.value)) {
      return this.advance();
    }
    throw new Error(`Expected identifier-like token, got ${t.kind} ("${t.value}") at ${t.line}:${t.col}`);
  }
  private advance(): Token { return this.tokens[this.pos++]; }
  private at(kind: TokenKind): boolean { return this.peek().kind === kind; }
  private atValue(kind: TokenKind, value: string): boolean { return this.peek().kind === kind && this.peek().value === value; }

  private expect(kind: TokenKind): Token {
    const t = this.peek();
    if (t.kind !== kind) throw new Error(`Expected ${kind}, got ${t.kind} ("${t.value}") at ${t.line}:${t.col}`);
    return this.advance();
  }

  private match(kind: TokenKind): Token | null {
    if (this.at(kind)) return this.advance();
    return null;
  }

  // ═══ TOP-LEVEL: PROGRAM ══════════════════════════════════════════════

  parseProgram(): Statement[] {
    const stmts: Statement[] = [];
    while (!this.at('EOF')) {
      // Skip semicolons between statements
      while (this.match('SEMICOLON')) {}
      if (this.at('EOF')) break;
      stmts.push(this.parseStatement());
    }
    return stmts;
  }

  // ═══ STATEMENTS ══════════════════════════════════════════════════════

  /** Skip comment tokens, collecting them as statements. */
  private skipComments(stmts?: Statement[]): void {
    while (this.at('COMMENT')) {
      const t = this.advance();
      if (stmts) stmts.push({ kind: 'comment', text: t.value, line: t.line });
    }
  }

  parseStatement(): Statement {
    // Comment: preserved as narrative context
    if (this.at('COMMENT')) {
      const t = this.advance();
      return { kind: 'comment', text: t.value, line: t.line };
    }

    // Spread statement: `...expr` — expr must evaluate to a string of
    // ft text that gets pasted inline at this position. See walker.
    if (this.at('SPREAD')) {
      this.advance();
      const expr = this.parseExpr();
      return { kind: 'spread_stmt', expr };
    }

    // delete x
    if (this.at('DELETE')) {
      this.advance();
      return { kind: 'delete', path: this.parsePath() };
    }

    // tool path [when cond]
    if (this.at('CAP')) {
      this.advance();
      const path = this.parsePath();
      const when = this.at('WHEN') ? this.parseWhenClause() : undefined;
      return { kind: 'tool', path, when };
    }

    // policy path: spec
    if (this.at('POLICY')) {
      this.advance();
      const path = this.parsePath();
      this.expect('COLON');
      const spec = this.parseObjectLiteral();
      return { kind: 'policy', path, spec: spec as Record<string, unknown> };
    }

    // class Name(deps) while cond { body }
    if (this.at('CLASS')) {
      return this.parseClassStatement();
    }

    // index anchor { over v in set ... where cond ... body }
    if (this.at('INDEX')) {
      return this.parseIndexStatement();
    }

    // in path [= backing] [while cond] { body } — scoped context
    if (this.at('IN')) {
      return this.parseInStatement();
    }

    // where (conds) { stmts } — conditional scope gate
    if (this.at('WHERE')) {
      return this.parseWhereStatement();
    }

    // reader name { source = ..., mode = ..., ... }
    if (this.at('READER')) {
      return this.parseReaderStatement();
    }

    // import name from 'path'
    if (this.at('IMPORT')) {
      this.advance();
      const name = this.expect('IDENT').value;
      this.expect('FROM');
      const from = this.expect('STRING').value;
      return { kind: 'import', name, from };
    }

    // export expr
    if (this.at('EXPORT')) {
      this.advance();
      return { kind: 'export', value: this.parseExpr() };
    }

    // x = expr | x << expr
    const path = this.parsePath();

    if (this.match('NARROW')) {
      const value = this.parseExpr();
      const modifiers = this.parseModifiers();
      return { kind: 'narrow', path, value, modifiers } as NarrowStatement;
    }

    this.expect('ASSIGN');
    const value = this.parseExpr();
    const modifiers = this.parseModifiers();
    return { kind: 'assign', path, value, modifiers } as AssignStatement;
  }

  // ═══ CLASS ═══════════════════════════════════════════════════════════

  /**
   * Parse: class Name(param: Type, ...) [while cond] { body }
   *
   * Constructor params become where-clause deps.
   * while clause = lifecycle (dispose = while break).
   * Body contains property declarations (assign) and method definitions (fn types).
   * `this` is the class prefix path — all state lives under it.
   * `prev` in method bodies = getPrevious on the class's sequence paths.
   */
  private parseClassStatement(): Statement {
    this.advance(); // consume 'class'
    const name = this.expect('IDENT').value;

    // Constructor params: (param: Type, param: Type, ...)
    const params: { name: string; type: Expr; optional: boolean }[] = [];
    if (this.match('LPAREN')) {
      while (!this.at('RPAREN') && !this.at('EOF')) {
        const pName = this.expect('IDENT').value;
        const optional = !!this.match('QUESTION');
        this.expect('COLON');
        const pType = this.parseExpr();
        params.push({ name: pName, type: pType, optional });
        this.match('COMMA');
      }
      this.expect('RPAREN');
    }

    // Optional while clause (lifecycle condition)
    let whileClause: import('./ast').ConditionExpr[] | undefined;
    if (this.at('WHILE')) {
      this.advance();
      whileClause = [this.parseCondition()];
      while (this.match('COMMA')) whileClause.push(this.parseCondition());
    }

    // Body: { statements }
    this.expect('LBRACE');
    const body: Statement[] = [];
    while (!this.at('RBRACE') && !this.at('EOF')) {
      this.skipComments(body);
      if (this.at('RBRACE')) break;
      body.push(this.parseStatement());
      this.match('SEMICOLON');
    }
    this.expect('RBRACE');

    return { kind: 'class', name, params, whileClause, body };
  }

  // ═══ INDEX ═══════════════════════════════════════════════════════════

  /**
   * Parse: index <anchor> { over <v> in <set> [...] [where <cond>[,<cond>]*] <body> }
   *
   * Declarative surface for `indexSpec`-constrained schemas. Mounts a
   * schema at `anchor` carrying an index constraint that projects a
   * tuple space over the `over` bindings, filters via `where`, and
   * fires the body once per tuple (paths/strings get `{var}`
   * interpolation at fire time).
   *
   * All `over` clauses must precede the `where` clause. The body
   * starts at the first non-over / non-where statement inside the
   * braces and runs to the closing brace — body statements may be
   * assigns, narrows, or nested scopes.
   */
  private parseIndexStatement(): Statement {
    this.advance(); // consume 'index'
    const anchor = this.parsePath();
    this.expect('LBRACE');

    const overs: { variable: string; from: string }[] = [];
    while (this.at('OVER')) {
      this.advance();
      const variable = this.expect('IDENT').value;
      this.expect('IN');
      const from = this.parsePath();
      overs.push({ variable, from });
      this.match('SEMICOLON');
    }

    let filter: import('./ast').ConditionExpr[] | undefined;
    if (this.at('WHERE')) {
      this.advance();
      // Optional parens around the condition list — match reader/fn
      // where-syntax which accepts both `where cond` and `where (cond, cond)`.
      const parenthesized = !!this.match('LPAREN');
      filter = [this.parseCondition()];
      while (this.match('COMMA')) filter.push(this.parseCondition());
      if (parenthesized) this.expect('RPAREN');
      this.match('SEMICOLON');
    }

    const body: Statement[] = [];
    while (!this.at('RBRACE') && !this.at('EOF')) {
      this.skipComments(body);
      if (this.at('RBRACE')) break;
      body.push(this.parseStatement());
      this.match('SEMICOLON');
    }
    this.expect('RBRACE');

    return { kind: 'index', anchor, overs, filter, body };
  }

  /**
   * Parse: reader name { key = value, key = value, ... }
   *
   * A reader is a mounted observation contract. Properties declare:
   *   source — what to observe (path or pattern)
   *   mode — stable | partial | implications | history
   *   filter — predicate on observed paths
   *   limit — max items
   *   expand — cursor expression for pagination
   *   sink — where to write output
   *   render — rendering hint (numbered_list, commit_list, tool_buttons, etc.)
   *   depth — implication traversal depth
   */
  private parseReaderStatement(): Statement {
    this.advance(); // consume 'reader'
    const name = this.expect('IDENT').value;
    this.expect('LBRACE');
    const properties: { key: string; value: import('./ast').Expr }[] = [];
    while (!this.at('RBRACE') && !this.at('EOF')) {
      this.skipComments();
      if (this.at('RBRACE')) break;
      const key = this.expect('IDENT').value;
      this.expect('ASSIGN');
      const value = this.parseExpr();
      properties.push({ key, value });
      this.match('COMMA');
      this.match('SEMICOLON');
    }
    this.expect('RBRACE');
    return { kind: 'reader', name, properties };
  }

  // ═══ MODIFIERS ═══════════════════════════════════════════════════════

  private parseModifiers(): Modifiers {
    const m: Modifiers = {};

    if (this.at('WHEN')) {
      m.when = this.parseWhenClause();
    }

    if (this.at('WHILE')) {
      this.advance();
      m.while = [this.parseCondition()];
      while (this.match('COMMA')) m.while.push(this.parseCondition());
    }

    if (this.at('ONBREAK')) {
      this.advance();
      const path = this.parsePath();
      this.expect('ASSIGN');
      const value = this.parseExpr();
      m.onBreak = { path, value };
    }

    if (this.at('BY')) {
      this.advance();
      m.author = this.expect('STRING').value;
    }

    return m;
  }

  private parseWhenClause(): ConditionExpr[] {
    this.expect('WHEN');
    const conds = [this.parseCondition()];
    while (this.match('COMMA')) conds.push(this.parseCondition());
    return conds;
  }

  // ═══ CONDITIONS ══════════════════════════════════════════════════════

  private parseCondition(): ConditionExpr {
    // NOT
    if (this.at('NOT')) {
      this.advance();
      return { kind: 'not', clause: this.parseCondition() };
    }

    // exists(path) — call form. The postfix form `path EXISTS` is
    // handled below; this branch accepts the function-call reading
    // which matches how existence is written in most real code.
    if (this.at('EXISTS')) {
      this.advance();
      this.expect('LPAREN');
      const path = this.parsePath();
      this.expect('RPAREN');
      return { kind: 'exists', path };
    }

    // EXISTS / path EXISTS
    if (this.at('IDENT') || this.at('VARIABLE')) {
      const savedPos = this.pos;
      const path = this.parsePath();

      if (this.at('EXISTS')) {
        this.advance();
        return { kind: 'exists', path };
      }

      // Comparison: path op value
      if (this.at('ASSIGN') || this.at('NEQ') || this.at('LT') || this.at('LTE') || this.at('GT') || this.at('GTE')) {
        const op = this.advance().value as '=' | '!=' | '<' | '<=' | '>' | '>=';
        const rhs = this.parseExpr();
        return { kind: 'compare', lhs: { kind: 'name', name: path }, op, rhs };
      }

      // MATCHES tokenizes as its own keyword kind — the IDENT-value form
      // is kept for safety but could never fire alone (found 2026-07-24).
      if (this.at('MATCHES') || this.atValue('IDENT', 'MATCHES')) {
        this.advance();
        const pattern = this.expect('REGEX').value;
        return { kind: 'matches', path, pattern };
      }

      // Rewind if nothing matched
      this.pos = savedPos;
    }

    throw new Error(`Unexpected token in condition: ${this.peek().kind} ("${this.peek().value}") at ${this.peek().line}:${this.peek().col}`);
  }

  // ═══ EXPRESSIONS ═════════════════════════════════════════════════════

  parseExpr(): Expr {
    let left = this.parsePrimaryExpr();

    // Arithmetic: A + B, A - B, A * B, A / B
    while (this.at('PLUS') || this.at('MINUS') || this.at('STAR') || this.at('SLASH')) {
      const op = this.advance().value as '+' | '-' | '*' | '/';
      const right = this.parsePrimaryExpr();
      left = { kind: 'binop', op, lhs: left, rhs: right };
    }

    // Union: A | B  (but not refinement | — that's inside { })
    // Intersection: A & B
    while (true) {
      if (this.at('AMPERSAND')) {
        this.advance();
        const right = this.parsePrimaryExpr();
        left = { kind: 'intersection', members: flatIntersection(left, right) };
      } else if (this.at('PIPE') && !this.inRefinementContext) {
        // Disambiguate union vs refinement: `"a" | "b"` is a union of
        // types, but `true | read(p).content = content` is a predicate
        // on the value. A bounded lookahead decides: a predicate
        // OPERATOR before the next depth-0 terminator means refinement.
        // Without this, refinements after literal-typed properties
        // (the write/read identity clause's real position in the spec)
        // could never parse (2026-07-24).
        if (this.pipeStartsPredicate()) {
          return this.parseRefinement(left);
        }
        this.advance();
        const right = this.parsePrimaryExpr();
        left = { kind: 'union', branches: flatUnion(left, right) };
      } else {
        break;
      }
    }

    return left;
  }

  /** At a PIPE: does what follows read as a predicate rather than a
   *  union branch? Scan ahead (bounded, no consumption) for a predicate
   *  operator at nesting depth 0 before a terminator. `->` ends the
   *  scan too: a fn type after `|` is a union branch, and any predicate
   *  belongs to the fn's own output type. */
  private pipeStartsPredicate(): boolean {
    let i = this.pos + 1; // token after the PIPE
    let depth = 0;
    while (i < this.tokens.length) {
      const t = this.tokens[i];
      if (t.kind === 'LPAREN' || t.kind === 'LBRACE' || t.kind === 'LBRACKET') depth++;
      else if (t.kind === 'RPAREN' || t.kind === 'RBRACKET') { if (depth === 0) return false; depth--; }
      else if (t.kind === 'RBRACE') { if (depth === 0) return false; depth--; }
      else if (depth === 0) {
        if (t.kind === 'ASSIGN' || t.kind === 'NEQ' || t.kind === 'LT' || t.kind === 'LTE'
          || t.kind === 'GT' || t.kind === 'GTE' || t.kind === 'MATCHES' || t.kind === 'HAS'
          || t.kind === 'IN' || t.kind === 'SATISFIES' || t.kind === 'FORALL') {
          return true;
        }
        if (t.kind === 'COMMA' || t.kind === 'PIPE' || t.kind === 'ARROW' || t.kind === 'EOF'
          || t.kind === 'WHEN' || t.kind === 'WHILE' || t.kind === 'BY') {
          return false;
        }
      }
      i++;
    }
    return false;
  }

  private inRefinementContext = false;

  private parsePrimaryExpr(): Expr {
    const t = this.peek();

    // let $var = expr
    if (this.at('LET')) {
      this.advance();
      const name = this.expect('VARIABLE').value;
      this.expect('ASSIGN');
      const value = this.parseExpr();
      return { kind: 'let', name, value };
    }

    // prev or prev.path
    if (this.at('PREV')) {
      this.advance();
      let path: string | undefined;
      if (this.match('DOT')) path = this.parsePath();
      return { kind: 'prev', path };
    }

    // ref(path)
    if (this.at('REF')) {
      this.advance();
      this.expect('LPAREN');
      const path = this.parsePath();
      this.expect('RPAREN');
      return { kind: 'ref', path };
    }

    // snapshot(path)
    if (this.at('SNAPSHOT')) {
      this.advance();
      this.expect('LPAREN');
      const path = this.parsePath();
      this.expect('RPAREN');
      return { kind: 'snapshot', path };
    }

    // Expansion token: [[ label : description ]] or [[ description ]]
    if (this.at('EXPANSION')) {
      const raw = this.advance().value;
      const colonIdx = raw.indexOf(':');
      if (colonIdx >= 0) {
        return { kind: 'expansion', label: raw.slice(0, colonIdx).trim(), description: raw.slice(colonIdx + 1).trim() };
      }
      return { kind: 'expansion', description: raw };
    }

    // Literals
    if (this.at('STRING')) return { kind: 'literal', value: this.advance().value };
    if (this.at('NUMBER')) return { kind: 'literal', value: parseFloat(this.advance().value) };
    if (this.at('TRUE')) { this.advance(); return { kind: 'literal', value: true }; }
    if (this.at('FALSE')) { this.advance(); return { kind: 'literal', value: false }; }
    if (this.at('NULL')) { this.advance(); return { kind: 'literal', value: null }; }

    // Block: { ... } — could be object type, object literal, or scoped block
    if (this.at('LBRACE')) return this.parseBlockOrObject();

    // Array: [ ... ]
    if (this.at('LBRACKET')) return this.parseArrayExpr();

    // Function: ( ... ) -> ...
    if (this.at('LPAREN')) return this.parseFunctionExpr();

    // Primitives: string, number, boolean, null
    if (this.at('IDENT') && ['string', 'number', 'boolean'].includes(t.value)) {
      return this.parsePrimitiveExpr();
    }

    // Name reference (identifier, possibly dotted)
    if (this.at('IDENT') || this.at('VARIABLE')) {
      // Special primitive: `project(set, mapper).where(cond)`
      if (t.kind === 'IDENT' && t.value === 'project' && this.tokens[this.pos + 1]?.kind === 'LPAREN') {
        return this.parseProjectExpr();
      }
      const name = this.parsePath();
      // Function call: name(args)
      if (this.at('LPAREN')) {
        return this.parseCallExpr(name);
      }
      return this.at('VARIABLE') ? { kind: 'name', name: '$' + t.value } : { kind: 'name', name };
    }

    throw new Error(`Unexpected token: ${t.kind} ("${t.value}") at ${t.line}:${t.col}`);
  }

  // ═══ SPECIFIC EXPRESSION TYPES ═══════════════════════════════════════

  private parsePrimitiveExpr(): Expr {
    const base = this.advance().value as 'string' | 'number' | 'boolean';
    const constraints: PrimitiveConstraint[] = [];

    if (base === 'string') {
      if (this.at('REGEX')) constraints.push({ op: 'pattern', value: this.advance().value });
      if (this.at('NUMBER')) {
        const min = parseFloat(this.advance().value);
        if (this.match('DOTDOT')) {
          const max = parseFloat(this.expect('NUMBER').value);
          constraints.push({ op: 'length', min, max });
        } else {
          constraints.push({ op: 'length', min });
        }
      }
    }

    if (base === 'number') {
      // number.integer
      if (this.at('DOT') && this.tokens[this.pos + 1]?.value === 'integer') {
        this.advance(); this.advance();
        constraints.push({ op: 'integer' });
      }
      // >= N, <= N, N..M
      if (this.at('GTE')) { this.advance(); constraints.push({ op: 'min', value: parseFloat(this.expect('NUMBER').value) }); }
      else if (this.at('GT')) { this.advance(); constraints.push({ op: 'min', value: parseFloat(this.expect('NUMBER').value) + 0.000001 }); }
      else if (this.at('NUMBER')) {
        const lo = parseFloat(this.advance().value);
        if (this.match('DOTDOT')) {
          const hi = parseFloat(this.expect('NUMBER').value);
          constraints.push({ op: 'range', lo, hi });
        } else {
          constraints.push({ op: 'min', value: lo });
        }
      }
    }

    const prim: Expr = { kind: 'primitive', base: base === 'boolean' ? 'boolean' : base, constraints };

    // Check for refinement: | predicate — but ONLY when the lookahead
    // actually reads as a predicate. `string | null` in a property is a
    // UNION; the unconditional refinement-routing here made primitive
    // unions unparseable in property position (pre-existing, found
    // 2026-07-24). Non-predicate pipes fall through to the union loop.
    if (this.at('PIPE') && this.pipeStartsPredicate()) return this.parseRefinement(prim);

    return prim;
  }

  private parseBlockOrObject(): Expr {
    this.expect('LBRACE');

    // Empty block
    if (this.at('RBRACE')) { this.advance(); return { kind: 'object', properties: [] }; }

    // Check if this is a scoped block (has import/export/=) or an object type (has :)
    const savedPos = this.pos;

    // Peek ahead to determine block type. POLICY followed by COLON is
    // the property KEY "policy" (`{ policy: "add-wins" }`), not a
    // policy statement (2026-07-24).
    if (this.at('IMPORT') || this.at('EXPORT') || this.at('CAP') || this.at('DELETE')
      || (this.at('POLICY') && this.tokens[this.pos + 1]?.kind !== 'COLON')) {
      // Definitely a scoped block
      this.pos = savedPos;
      return this.parseBlock();
    }

    // Check: if first token is followed by COLON → object type
    // If first token is followed by ASSIGN or NARROW → scoped block
    // Accept any token that could be a property name (idents + keywords + STRING/STAR for glob keys)
    const isPropertyStart = this.at('IDENT') || this.at('VARIABLE')
      || this.at('TYPE') || this.at('WHEN') || this.at('WHILE') || this.at('REF')
      || this.at('PREV') || this.at('FROM') || this.at('POLICY')
      || this.at('STRING') || this.at('STAR');
    if (isPropertyStart) {
      const lookAhead = this.tokens[this.pos + 1];
      if (lookAhead && (lookAhead.kind === 'COLON' || (lookAhead.kind === 'QUESTION' && this.tokens[this.pos + 2]?.kind === 'COLON'))) {
        this.pos = savedPos;
        return this.parseObjectExpr();
      }
      if (lookAhead && (lookAhead.kind === 'ASSIGN' || lookAhead.kind === 'NARROW')) {
        this.pos = savedPos;
        return this.parseBlock();
      }
    }

    // Refinement: { base_type | predicate }
    if (this.at('PIPE')) {
      this.pos = savedPos;
      // This is a refinement with implicit base
      return this.parseBlock();
    }

    // Default: try as object type
    this.pos = savedPos;
    return this.parseObjectExpr();
  }

  private parseBlock(): Expr {
    const stmts: Statement[] = [];
    while (!this.at('RBRACE') && !this.at('EOF')) {
      // Commas are accepted alongside semicolons/newlines: the patch
      // form `m << { total = 0, updateCount = 0 }` writes statements
      // comma-separated, object-literal style (2026-07-24).
      while (this.match('SEMICOLON') || this.match('COMMA')) {}
      this.skipComments(stmts);
      if (this.at('RBRACE')) break;
      stmts.push(this.parseStatement());
    }
    this.expect('RBRACE');
    return { kind: 'block', statements: stmts };
  }

  /** Accept an identifier OR a keyword OR a quoted string as a
   *  property name. String form is necessary for glob keys in type
   *  annotations like `{ "p_*": T }` or `{ "*": T }` — standalone
   *  `*` is also accepted for the simple wildcard case. */
  private expectPropertyKey(): string {
    const t = this.peek();
    // Quoted string keys — needed for glob/compound keys
    if (t.kind === 'STRING') return this.advance().value;
    // Bare `*` as a wildcard key
    if (t.kind === 'STAR') { this.advance(); return '*'; }
    // Dotted keys (`segments.prefix: T`) — consume the whole path.
    if (t.kind === 'IDENT' && this.tokens[this.pos + 1]?.kind === 'DOT') {
      let key = this.advance().value;
      while (this.at('DOT')) {
        this.advance();
        key += '.' + this.expect('IDENT').value;
      }
      return key;
    }
    // Keywords are valid property names in object position
    if (t.kind === 'IDENT' || t.kind === 'TYPE' || t.kind === 'WHEN' || t.kind === 'WHILE'
      || t.kind === 'DELETE' || t.kind === 'CAP' || t.kind === 'POLICY' || t.kind === 'BY'
      || t.kind === 'IMPORT' || t.kind === 'FROM' || t.kind === 'EXPORT'
      || t.kind === 'LET' || t.kind === 'REF' || t.kind === 'SNAPSHOT' || t.kind === 'PREV'
      || t.kind === 'FORALL' || t.kind === 'PRESERVES'
      || t.kind === 'EXISTS' || t.kind === 'NOT'
      || t.kind === 'MATCHES' || t.kind === 'HAS' || t.kind === 'IN' || t.kind === 'SATISFIES'
      || t.kind === 'TRUE' || t.kind === 'FALSE' || t.kind === 'NULL'
    ) {
      return this.advance().value;
    }
    return this.expect('IDENT').value;
  }

  private parseObjectExpr(): Expr {
    const properties: { key: string; value: Expr; optional: boolean; modifiers?: Modifiers }[] = [];
    while (!this.at('RBRACE') && !this.at('EOF')) {
      this.skipComments(); // skip inline comments
      if (this.at('RBRACE')) break;
      const key = this.expectPropertyKey();
      const optional = !!this.match('QUESTION');
      this.expect('COLON');
      const value = this.parseExpr();
      // Property-level gates (the spec's Worker example:
      // `task: string while alive = true onBreak events.taskExpired = true`).
      // Single condition per gate here — the COMMA belongs to the
      // property list, not a condition list. The walker LOWERS these to
      // child statements with the same modifiers, so the semantics are
      // exactly the statement-level gates', nothing new.
      if (this.at('WHEN') || this.at('WHILE') || this.at('ONBREAK') || this.at('BY')) {
        properties.push({ key, value, optional, modifiers: this.parsePropertyModifiers() });
      } else {
        properties.push({ key, value, optional });
      }

      this.match('COMMA');
    }
    this.expect('RBRACE');
    return { kind: 'object', properties };
  }

  /** Statement modifiers restricted to property position: when/while
   *  take exactly ONE condition (no comma continuation). */
  private parsePropertyModifiers(): Modifiers {
    const m: Modifiers = {};
    if (this.at('WHEN')) {
      this.advance();
      m.when = [this.parseCondition()];
    }
    if (this.at('WHILE')) {
      this.advance();
      m.while = [this.parseCondition()];
    }
    if (this.at('ONBREAK')) {
      this.advance();
      const path = this.parsePath();
      this.expect('ASSIGN');
      const value = this.parseExpr();
      m.onBreak = { path, value };
    }
    if (this.at('BY')) {
      this.advance();
      m.author = this.expect('STRING').value;
    }
    return m;
  }

  private parseArrayExpr(): Expr {
    this.expect('LBRACKET');
    this.skipComments(); // narrative rows inside [ ] blocks
    if (this.at('RBRACKET')) {
      this.advance();
      return { kind: 'array', element: { kind: 'primitive', base: 'null', constraints: [] } };
    }

    // Parse first element (may be spread)
    const firstSpread = !!this.match('SPREAD');
    const first = this.parseExpr();

    // Check for multi-element / segmented array: [T1, ...T2, T3]
    if (this.at('COMMA')) {
      const saved = this.pos;
      this.advance();
      // Distinguish multi-element from length constraint [Type, min..max]
      const isLengthConstraint = this.at('NUMBER') &&
        this.tokens[this.pos + 1]?.kind !== 'COMMA' &&
        this.tokens[this.pos + 1]?.kind !== 'RBRACKET' &&
        !firstSpread;

      if (!isLengthConstraint) {
        // Multi-element / segmented array
        const elements: import('./ast').ArrayElement[] = [{ expr: first, spread: firstSpread }];
        if (!this.at('RBRACKET')) {
          const sp = !!this.match('SPREAD');
          elements.push({ expr: this.parseExpr(), spread: sp });
          while (this.match('COMMA')) {
            if (this.at('RBRACKET')) break;
            const sp2 = !!this.match('SPREAD');
            elements.push({ expr: this.parseExpr(), spread: sp2 });
          }
        }
        this.expect('RBRACKET');
        return { kind: 'array', element: first, elements };
      }
      // Length constraint — restore position
      this.pos = saved;
    }

    // Single element array type: [Type] or [Type, min..max]
    let minLength: number | undefined;
    let maxLength: number | undefined;
    if (this.match('COMMA')) {
      if (this.at('NUMBER')) {
        minLength = parseFloat(this.advance().value);
        if (this.match('DOTDOT')) {
          maxLength = parseFloat(this.expect('NUMBER').value);
        }
      }
    }
    this.expect('RBRACKET');
    if (firstSpread) {
      // [...Type] = array of Type (spread in single-element position = just the array type)
      return { kind: 'array', element: first, minLength, maxLength };
    }
    return { kind: 'array', element: first, minLength, maxLength };
  }

  private parseFunctionExpr(): Expr {
    this.expect('LPAREN');
    const params: { name: string; type: Expr; optional: boolean }[] = [];
    while (!this.at('RPAREN') && !this.at('EOF')) {
      const name = this.expectPropertyKey(); // keywords are valid param names
      const optional = !!this.match('QUESTION');
      this.expect('COLON');
      const type = this.parseExpr();
      params.push({ name, type, optional });
      this.match('COMMA');
    }
    this.expect('RPAREN');
    this.expect('ARROW');

    // Block-body fn def: `-> [ stmts ]` (optionally `: ReturnType`).
    // Discriminate from array-returning fn type `-> [Type]` by peeking
    // for an assign/narrow inside the brackets — statements always
    // contain `=` or `<<`, type expressions never do.
    //
    // The return type annotation is OPTIONAL for block-body fn defs.
    // When absent, the block's compiled state (compose of all its
    // mount statements) IS the output. When present, it must be
    // consistent with that compiled state — future backwards
    // inference will enforce the match. No implicit reduction /
    // export magic; the body is a statement block, not a value block.
    if (this.at('LBRACKET') && this.looksLikeBlockBody()) {
      this.advance(); // consume [
      const body: Statement[] = [];
      while (!this.at('RBRACKET') && !this.at('EOF')) {
        while (this.match('SEMICOLON')) {}
        this.skipComments(body);
        if (this.at('RBRACKET')) break;
        body.push(this.parseStatement());
      }
      this.expect('RBRACKET');
      let returns: Expr | undefined;
      if (this.match('COLON')) {
        returns = this.parseExpr();
      }
      return { kind: 'function', params, returns, body };
    }

    let returns = this.parseExpr();

    // Distribution on function: ~family(params)
    let distribution: { family: string; params: Record<string, number> } | undefined;
    if (this.at('TILDE')) {
      this.advance();
      distribution = this.parseDistribution();
    }

    return { kind: 'function', params, returns, distribution };
  }

  /**
   * Look ahead from the current `[` and decide whether it opens a
   * block body (statements) or an array type expression. If a top-
   * level `=` or `<<` appears before the matching `]`, it's a block.
   */
  private looksLikeBlockBody(): boolean {
    let depth = 0;
    let i = this.pos + 1; // skip [
    while (i < this.tokens.length) {
      const t = this.tokens[i];
      if (t.kind === 'EOF') return false;
      if (t.kind === 'LBRACKET' || t.kind === 'LBRACE' || t.kind === 'LPAREN') depth++;
      else if (t.kind === 'RBRACKET') {
        if (depth === 0) return false;
        depth--;
      }
      else if (t.kind === 'RBRACE' || t.kind === 'RPAREN') depth--;
      else if (depth === 0 && (t.kind === 'ASSIGN' || t.kind === 'NARROW' || t.kind === 'DELETE'
        || t.kind === 'CAP' || t.kind === 'SPREAD' || t.kind === 'CLASS' || t.kind === 'IMPORT'
        || t.kind === 'EXPORT'
        // POLICY/READER followed by COLON is a property KEY named
        // "policy"/"reader", not a statement — `{ policy: "add-wins" }`
        // must stay an object (2026-07-24).
        || (t.kind === 'POLICY' && this.tokens[i + 1]?.kind !== 'COLON')
        || (t.kind === 'READER' && this.tokens[i + 1]?.kind !== 'COLON')
        || t.kind === 'WHERE')) {
        return true;
      }
      i++;
    }
    return false;
  }

  private parseCallExpr(fnName: string): Expr {
    this.expect('LPAREN');
    const args: Expr[] = [];
    while (!this.at('RPAREN') && !this.at('EOF')) {
      args.push(this.parseExpr());
      this.match('COMMA');
    }
    this.expect('RPAREN');
    // Postfix result path: `read(p).content`, `next_write(p).T_out` —
    // a symbolic path INTO the call's result. This is the LHS of the
    // write/read identity clause and the anchor of Δt intervals
    // (DSL_REQUIREMENTS "Temporal"); until 2026-07-24 the DOT here
    // threw and the whole clause family was unreachable from text.
    if (this.at('DOT')) {
      const resultPath: string[] = [];
      while (this.at('DOT')) {
        this.advance();
        resultPath.push(this.expect('IDENT').value);
      }
      return { kind: 'call', fn: fnName, args, resultPath };
    }
    return { kind: 'call', fn: fnName, args };
  }

  /**
   * Parse `where (cond [, cond ...]) { stmts }` — conditional
   * scope gate. Conditions are comma-separated with implicit AND.
   * Body is a statement list. No bindings are introduced by the
   * where itself; condition references resolve via the enclosing
   * scope (fn params when inside a block-body fn def, or
   * top-level if no enclosing scope).
   */
  private parseInStatement(): Statement {
    this.expect('IN');
    // Parse scope path as dot-separated idents — DON'T use
    // parsePath() because it consumes `{` as a {var} segment,
    // which collides with the body block's opening brace.
    let path = this.expect('IDENT').value;
    while (this.match('DOT')) {
      path += '.' + this.expect('IDENT').value;
    }

    // Optional backing: `= expr`
    let backing: import('./ast').Expr | undefined;
    if (this.match('ASSIGN')) {
      backing = this.parseExpr();
    }

    // Optional while clause
    let whileClause: import('./ast').ConditionExpr[] | undefined;
    if (this.at('WHILE')) {
      this.advance();
      whileClause = [this.parseCondition()];
      while (this.match('COMMA')) whileClause.push(this.parseCondition());
    }

    // Body
    this.expect('LBRACE');
    const body: import('./ast').Statement[] = [];
    while (!this.at('RBRACE') && !this.at('EOF')) {
      while (this.match('SEMICOLON')) {}
      if (this.at('RBRACE')) break;
      body.push(this.parseStatement());
    }
    this.expect('RBRACE');
    return { kind: 'in', path, backing, whileClause, body };
  }

  private parseWhereStatement(): Statement {
    this.expect('WHERE');
    this.expect('LPAREN');
    const conditions: ConditionExpr[] = [];
    if (!this.at('RPAREN')) {
      conditions.push(this.parseCondition());
      while (this.match('COMMA')) conditions.push(this.parseCondition());
    }
    this.expect('RPAREN');
    this.expect('LBRACE');
    const body: Statement[] = [];
    while (!this.at('RBRACE') && !this.at('EOF')) {
      while (this.match('SEMICOLON')) {}
      this.skipComments(body);
      if (this.at('RBRACE')) break;
      body.push(this.parseStatement());
    }
    this.expect('RBRACE');
    return { kind: 'where_stmt', conditions, body };
  }

  /**
   * Parse `project(BINDING in SET, MAPPER).where(cond)`.
   *
   * BINDING is an identifier declaring the iteration variable —
   * visible in the filter as `BINDING.field`. SET is a path
   * expression containing one or more `{name}` wildcards; each
   * wildcard becomes a field on the binding. MAPPER is a bare fn
   * name invoked per qualifying match with the binding as input.
   *
   * The `BINDING in SET` form is REQUIRED — there is no legacy
   * `project(set, fn)` without a binding. That form had an
   * implicit iteration scope that made filter references
   * unreadable (bare `status` silently referenced a record field
   * with no visible declaration). The explicit form forces every
   * name to trace to a declared origin.
   */
  private parseProjectExpr(): Expr {
    this.advance(); // consume `project`
    this.expect('LPAREN');

    // Binding declaration: <IDENT> in <SET>
    if (!this.at('IDENT')) {
      const t = this.peek();
      throw new Error(
        `project requires 'binding in set' form: expected IDENT, got ${t.kind} ("${t.value}") at ${t.line}:${t.col}`
      );
    }
    const binding = this.advance().value;
    if (!this.at('IN')) {
      const t = this.peek();
      throw new Error(
        `project requires 'binding in set' form: expected 'in' after binding name, got ${t.kind} ("${t.value}") at ${t.line}:${t.col}`
      );
    }
    this.advance(); // consume 'in'

    const set = this.parseExpr();
    this.expect('COMMA');
    const mapper = this.parseExpr();
    this.expect('RPAREN');

    let filter: ConditionExpr | undefined;
    // Optional `.where(cond [, cond ...])` chain — comma-separated
    // conditions join under an implicit AND, matching when/while
    // clause semantics elsewhere in the DSL.
    if (this.at('DOT') && this.tokens[this.pos + 1]?.kind === 'WHERE'
        && this.tokens[this.pos + 2]?.kind === 'LPAREN') {
      this.advance(); // .
      this.advance(); // where
      this.expect('LPAREN');
      const conditions: ConditionExpr[] = [this.parseCondition()];
      while (this.match('COMMA')) conditions.push(this.parseCondition());
      this.expect('RPAREN');
      filter = conditions.length === 1 ? conditions[0] : { kind: 'and', clauses: conditions };
    }

    return { kind: 'project', binding, set, mapper, filter };
  }

  // ═══ REFINEMENTS ═════════════════════════════════════════════════════

  private parseRefinement(base: Expr): Expr {
    const predicates: Predicate[] = [];
    this.inRefinementContext = true;

    while (this.at('PIPE')) {
      this.advance();

      // let binding
      if (this.at('LET')) {
        this.advance();
        const name = this.expect('VARIABLE').value;
        this.expect('ASSIGN');
        const value = this.parseExpr();
        // Let is treated as a predicate with an equality
        predicates.push({ kind: 'comparison', lhs: { kind: 'name', name: '$' + name }, op: '=', rhs: value });
        continue;
      }

      // forall
      if (this.at('FORALL')) {
        predicates.push(this.parseForall());
        continue;
      }

      // comparison predicate: lhs op rhs [@temporal] [~prob]
      predicates.push(this.parseComparisonPredicate());
    }

    this.inRefinementContext = false;
    return { kind: 'refined', base, predicates };
  }

  private parseComparisonPredicate(): Predicate {
    const lhs = this.parseExpr();
    const op = this.parsePredicateOp();
    let rhs: Expr;
    if (op === 'IN' && this.at('LBRACE')) {
      // Set literal: `role IN { "admin", "member" }` — a union of
      // literals, not an object type (which would demand key: value).
      this.advance();
      const branches: Expr[] = [];
      while (!this.at('RBRACE') && !this.at('EOF')) {
        branches.push(this.parseExpr());
        this.match('COMMA');
      }
      this.expect('RBRACE');
      rhs = { kind: 'union', branches };
    } else if (op === 'MATCHES' && this.at('REGEX')) {
      // `email MATCHES /re/` — the pattern is a literal, not an expr.
      rhs = { kind: 'literal', value: this.advance().value };
    } else {
      rhs = this.parseExpr();
    }

    let temporal: { from: Expr; until?: Expr } | undefined;
    if (this.at('AT')) {
      this.advance();
      this.expect('LBRACKET');
      const from = this.parseExpr();
      this.expect('DOTDOT');
      let until: Expr | undefined;
      if (!this.at('RPAREN')) {
        until = this.parseExpr();
      }
      this.expect('RPAREN');
      temporal = { from, until };
    }

    let probability: { family: string; distribution: string; params: Record<string, number> } | undefined;
    if (this.at('TILDE')) {
      this.advance();
      const dist = this.parseDistribution();
      probability = { family: 'survival', distribution: dist.family, params: dist.params };
    }

    return { kind: 'comparison', lhs, op, rhs, temporal, probability };
  }

  private parsePredicateOp(): ComparisonPredicate['op'] {
    if (this.match('ASSIGN')) return '=';
    if (this.match('NEQ')) return '!=';
    if (this.match('LT')) return '<';
    if (this.match('LTE')) return '<=';
    if (this.match('GT')) return '>';
    if (this.match('GTE')) return '>=';
    // MATCHES tokenizes as keyword kind MATCHES, exactly like HAS and
    // SATISFIES below — the IDENT-value check alone never fired, so
    // `| x MATCHES /re/` threw despite full walker support (2026-07-24).
    if (this.atValue('IDENT', 'MATCHES') || this.at('MATCHES')) { this.advance(); return 'MATCHES'; }
    if (this.atValue('IDENT', 'HAS') || this.at('HAS')) { this.advance(); return 'HAS'; }
    if (this.at('IN')) { this.advance(); return 'IN'; }
    if (this.atValue('IDENT', 'SATISFIES') || this.at('SATISFIES')) { this.advance(); return 'SATISFIES'; }
    throw new Error(`Expected predicate operator at ${this.peek().line}:${this.peek().col}, got ${this.peek().kind}`);
  }

  private parseForall(): Predicate {
    this.expect('FORALL');
    const variable = this.expect('IDENT').value;
    this.expect('COLON');
    // The set is an ident or a call — NOT a full expr, because a full
    // expr's dotted-path production would consume the `.` that
    // separates the set from the body (`forall c : cells . c >= 0`).
    const setName = this.expect('IDENT').value;
    const set: Expr = this.at('LPAREN')
      ? this.parseCallExpr(setName)
      : { kind: 'name', name: setName };
    this.expect('DOT');
    const body = this.parseComparisonPredicate();
    return { kind: 'forall', variable, set, body };
  }

  private parseDistribution(): { family: string; params: Record<string, number> } {
    const family = this.expect('IDENT').value;
    this.expect('LPAREN');
    const params: Record<string, number> = {};
    let subFamily: string | undefined;
    while (!this.at('RPAREN') && !this.at('EOF')) {
      if (this.at('IDENT')) {
        const key = this.advance().value;
        if (this.at('ASSIGN')) {
          this.advance();
          params[key] = parseFloat(this.expect('NUMBER').value);
        } else {
          // Bare ident positional param — the spec's `~survival(exp, 0.001)`
          // form, where the first arg names the underlying distribution.
          subFamily = subFamily ?? key;
        }
      } else if (this.at('NUMBER')) {
        params[`_${Object.keys(params).length}`] = parseFloat(this.advance().value);
      }
      this.match('COMMA');
    }
    this.expect('RPAREN');
    if (subFamily) {
      // survival(exp, r) → distribution exp with rate r; exp is shorthand
      // for the constraint layer's 'exponential' family.
      const mapped = subFamily === 'exp' ? 'exponential' : subFamily;
      const rate = params._0;
      return { family: mapped, params: rate !== undefined ? { rate } : params };
    }
    return { family, params };
  }

  // ═══ UTILITIES ═══════════════════════════════════════════════════════

  private parsePath(): string {
    let path = this.parsePathSegment();
    while (this.match('DOT')) {
      // Accept * as a path segment (glob: tasks.* means "every child of tasks")
      if (this.at('STAR')) {
        path += '.*';
        this.advance();
      } else {
        path += '.' + this.parsePathSegment();
      }
    }
    return path;
  }

  /**
   * Parse a single path segment. Handles plain idents, `{var}`
   * interpolation segments, and compound segments like
   * `p_{reqId}` or `{prefix}_suffix` where a literal glues to an
   * interpolation hole with no dot separator.
   *
   * Restriction: adjacent IDENT-IDENT is NOT allowed (that would
   * cross statement boundaries, since the tokenizer strips
   * whitespace). So `foo bar` on two lines stays as two tokens.
   * A segment can only extend across an IDENT if a `{var}`
   * hole appears between them.
   */
  private parsePathSegment(): string {
    // VARIABLE token ($name) only makes sense as the first thing
    // in a segment; keep the $ prefix and return immediately.
    if (this.at('VARIABLE')) {
      return '$' + this.advance().value;
    }
    let seg = '';
    let lastWasIdent = false;
    /** Track the column immediately after the last IDENT consumed.
     *  Compound segments (`p_{reqId}`) require the next `{` to sit
     *  flush against the preceding IDENT with no whitespace. Without
     *  this check, a path followed by an open-brace body (e.g.
     *  `index _sessions.active {`) greedily swallows the body's `{`
     *  as `{var}` interpolation. The tokenizer strips whitespace
     *  but keeps line/col on each token; we compare the next
     *  LBRACE's position against the IDENT's end to disambiguate. */
    let lastIdentEndLine = -1;
    let lastIdentEndCol = -1;
    while (true) {
      if (this.at('LBRACE')) {
        // Only accept this LBRACE as part of the current segment
        // when it's either the START of a fresh segment (seg === '')
        // OR directly adjacent to the prior IDENT with no whitespace.
        if (seg !== '') {
          const t = this.peek();
          if (t.line !== lastIdentEndLine || t.col !== lastIdentEndCol) break;
        }
        this.advance();
        const varName = this.expectIdentLike().value;
        this.expect('RBRACE');
        seg += `{${varName}}`;
        lastWasIdent = false;
      } else if (this.at('IDENT') && !lastWasIdent) {
        const t = this.peek();
        // An IDENT starts a new compound segment piece ONLY if it
        // sits flush against the prior brace (e.g. `{prefix}_suffix`).
        // Otherwise it's the next token in the outer parser's world
        // and should not fold into this segment.
        if (seg !== '' && (t.line !== lastIdentEndLine || t.col !== lastIdentEndCol)) break;
        const consumed = this.advance();
        seg += consumed.value;
        lastWasIdent = true;
        lastIdentEndLine = consumed.line;
        lastIdentEndCol = consumed.col + consumed.value.length;
      } else if (seg === '') {
        // First token of a new segment — accept keywords-used-as-
        // idents (policy, user, from, etc) so the caller's error
        // message surfaces at the right place if it really was
        // the wrong token.
        const consumed = this.advance();
        seg += consumed.value;
        return seg;
      } else {
        break;
      }
    }
    return seg;
  }

  private parseObjectLiteral(): Record<string, unknown> {
    this.expect('LBRACE');
    const obj: Record<string, unknown> = {};
    while (!this.at('RBRACE') && !this.at('EOF')) {
      const key = this.expect('IDENT').value;
      this.expect('COLON');
      if (this.at('STRING')) obj[key] = this.advance().value;
      else if (this.at('NUMBER')) obj[key] = parseFloat(this.advance().value);
      else if (this.at('TRUE')) { this.advance(); obj[key] = true; }
      else if (this.at('FALSE')) { this.advance(); obj[key] = false; }
      this.match('COMMA');
    }
    this.expect('RBRACE');
    return obj;
  }
}

// Helpers for flattening nested unions/intersections
function flatUnion(a: Expr, b: Expr): Expr[] {
  const left = a.kind === 'union' ? a.branches : [a];
  const right = b.kind === 'union' ? b.branches : [b];
  return [...left, ...right];
}

function flatIntersection(a: Expr, b: Expr): Expr[] {
  const left = a.kind === 'intersection' ? a.members : [a];
  const right = b.kind === 'intersection' ? b.members : [b];
  return [...left, ...right];
}

/** Parse an ft block string into AST statements. */
export function parse(source: string): Statement[] {
  // Top-level import, NOT a lazy require: the package is ESM
  // ("type": "module") — `require` does not exist at runtime, which
  // silently broke this export for every ESM consumer until the
  // office-eval smoke hit it (2026-07-17). No tokenizer↔parser cycle
  // exists; the laziness was never needed.
  const tokens = tokenize(source);
  return new Parser(tokens).parseProgram();
}
