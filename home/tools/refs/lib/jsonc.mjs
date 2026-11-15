// Purpose: parse JSON that may hold comments, trailing commas and a BOM (tsconfig, package.json) into a tree that keeps
//   the line of every value, so a finding can name the exact line.
// Exports: parseJsonc, JsonSyntaxError, objectGet, stringLeaves.
// Invariants: nodes are {kind: 'string'|'other', value, line}, {kind: 'object', entries: [{key, line, node}], line} or
//   {kind: 'array', items, line}. Lines count `\n`, so CRLF files give the same numbers. Nesting deeper than
//   MAX_DEPTH is a syntax error, never a stack overflow.
const MAX_DEPTH = 200;
const LITERAL = /-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?|true|false|null/y;

/** A syntax error with the line where it was found. */
export class JsonSyntaxError extends Error {
  constructor(message, line) {
    super(`${message} (line ${line})`);
    this.line = line;
  }
}

class Parser {
  constructor(text) {
    this.text = text.startsWith('﻿') ? text.slice(1) : text;
    this.pos = 0;
    this.line = 1;
  }

  fail(message) {
    throw new JsonSyntaxError(message, this.line);
  }

  skipTrivia() {
    const { text } = this;
    while (this.pos < text.length) {
      const char = text[this.pos];
      if (char === '\n') this.line += 1;
      if (char === '\n' || char === ' ' || char === '\t' || char === '\r') this.pos += 1;
      else if (char === '/' && text[this.pos + 1] === '/') this.pos = this.endOfLine();
      else if (char === '/' && text[this.pos + 1] === '*') this.skipBlockComment();
      else return;
    }
  }

  endOfLine() {
    const end = this.text.indexOf('\n', this.pos);
    return end === -1 ? this.text.length : end;
  }

  skipBlockComment() {
    const end = this.text.indexOf('*/', this.pos + 2);
    if (end === -1) this.fail('comment is not closed');
    this.line += this.text.slice(this.pos, end).split('\n').length - 1;
    this.pos = end + 2;
  }

  parseString() {
    const start = this.pos;
    let index = start + 1;
    for (; index < this.text.length && this.text[index] !== '"'; index += 1) {
      if (this.text[index] === '\\') index += 1;
      else if (this.text[index] === '\n') this.fail('string is not closed');
    }
    if (index >= this.text.length) this.fail('string is not closed');
    this.pos = index + 1;
    const raw = this.text.slice(start, this.pos);
    if (!raw.includes('\\')) return raw.slice(1, -1);
    try {
      return JSON.parse(raw);
    } catch {
      return this.fail('bad escape in string');
    }
  }

  parseValue(depth) {
    if (depth > MAX_DEPTH) this.fail('nested too deep');
    this.skipTrivia();
    const line = this.line;
    const char = this.text[this.pos];
    if (char === '{') return this.parseObject(depth, line);
    if (char === '[') return this.parseArray(depth, line);
    if (char === '"') return { kind: 'string', value: this.parseString(), line };
    LITERAL.lastIndex = this.pos;
    const match = LITERAL.exec(this.text);
    if (match === null) return this.fail(char === undefined ? 'unexpected end of file' : `unexpected "${char}"`);
    this.pos += match[0].length;
    return { kind: 'other', value: match[0], line };
  }

  /** Reads `open ... close` with items separated by commas, a trailing comma allowed. `readItem` consumes one item. */
  parseSequence(close, readItem) {
    this.pos += 1;
    for (;;) {
      this.skipTrivia();
      if (this.text[this.pos] === close) break;
      readItem();
      this.skipTrivia();
      if (this.text[this.pos] === ',') this.pos += 1;
      else if (this.text[this.pos] !== close) this.fail(`expected "," or "${close}"`);
    }
    this.pos += 1;
  }

  parseObject(depth, line) {
    const entries = [];
    this.parseSequence('}', () => {
      if (this.text[this.pos] !== '"') this.fail('expected a quoted key');
      const keyLine = this.line;
      const key = this.parseString();
      this.skipTrivia();
      if (this.text[this.pos] !== ':') this.fail('expected ":"');
      this.pos += 1;
      entries.push({ key, line: keyLine, node: this.parseValue(depth + 1) });
    });
    return { kind: 'object', entries, line };
  }

  parseArray(depth, line) {
    const items = [];
    this.parseSequence(']', () => items.push(this.parseValue(depth + 1)));
    return { kind: 'array', items, line };
  }
}

/**
 * Parses JSON with comments and trailing commas.
 * @param {string} text file content
 * @returns the root node
 * @throws {JsonSyntaxError} when the text is not JSON-like or has trailing content
 */
export function parseJsonc(text) {
  const parser = new Parser(text);
  const root = parser.parseValue(0);
  parser.skipTrivia();
  if (parser.pos < parser.text.length) parser.fail('unexpected text after the value');
  return root;
}

/** The node under `key` of an object node, or undefined. */
export function objectGet(node, key) {
  if (node?.kind !== 'object') return undefined;
  return node.entries.find((entry) => entry.key === key)?.node;
}

/** Every string node under a node (a string itself, array items, object values), depth first. */
export function stringLeaves(node) {
  if (node === undefined) return [];
  if (node.kind === 'string') return [node];
  if (node.kind === 'array') return node.items.flatMap(stringLeaves);
  if (node.kind === 'object') return node.entries.flatMap((entry) => stringLeaves(entry.node));
  return [];
}
