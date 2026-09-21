// Read the selected operation and its mutation root fields, never response fields or
// variable values. Unsupported documents fail closed; no GraphQL execution happens here.
export function graphqlOperation(body) {
  if (!body || typeof body.query !== 'string' || body.query.length > 1024*1024
    || body.operationName != null && typeof body.operationName !== 'string') return null;
  const lexer = /\s+|,|\uFEFF|#[^\r\n]*|"""(?:\\[\s\S]|(?!""")[\s\S])*"""|"(?:\\[\s\S]|[^"\\\r\n])*"|\.\.\.|[_A-Za-z][_0-9A-Za-z]*|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?|[!$&():=@\[\]{|}]/gy;
  const tokens = [];
  let offset = 0;
  while (offset < body.query.length) {
    lexer.lastIndex = offset;
    const match = lexer.exec(body.query);
    if (!match || tokens.length > 100000) return null;
    offset = lexer.lastIndex;
    if (!/^[\s,#\uFEFF]/.test(match[0])) tokens.push(match[0]);
  }
  let position = 0;
  const name = () => /^[_A-Za-z][_0-9A-Za-z]*$/.test(tokens[position] || '') ? tokens[position++] : null;
  const pairs = { '(':')', '[':']', '{':'}' };
  function group(open) {
    if (tokens[position++] !== open) throw new Error();
    const stack = [pairs[open]];
    while (stack.length) {
      const token = tokens[position++];
      if (!token) throw new Error();
      if (Object.hasOwn(pairs,token)) stack.push(pairs[token]);
      else if ([')',']','}'].includes(token) && token !== stack.pop()) throw new Error();
    }
  }
  function directives() {
    while (tokens[position] === '@') {
      position++; if (!name()) throw new Error();
      if (tokens[position] === '(') group('(');
    }
  }
  try {
    const type = tokens[position] === '{' ? 'query' : tokens[position++];
    if (!['query','mutation'].includes(type)) return null;
    const operationName = tokens[position] === '{' ? null : name();
    if (body.operationName != null && body.operationName !== operationName) return null;
    if (tokens[position] === '(') group('(');
    directives();
    const fields = [];
    if (type === 'query') group('{');
    else {
      if (tokens[position++] !== '{') return null;
      while (tokens[position] !== '}') {
        // Root fragment spreads are deliberately unsupported for mutations. Nested response
        // fragments are harmless and skipped with their enclosing response selection.
        const responseName = name(); if (!responseName) return null;
        let fieldName = responseName;
        if (tokens[position] === ':') { position++; fieldName = name(); if (!fieldName) return null; }
        const start = position;
        if (tokens[position] === '(') group('(');
        const argumentsText = tokens.slice(start,position).join(' ');
        directives();
        if (tokens[position] === '{') group('{');
        fields.push({ name:fieldName, responseName, argumentsText });
      }
      position++;
      if (!fields.length) return null;
    }
    // Apollo appends response fragments. Reject additional operations or malformed tails,
    // so a different selected mutation cannot hide behind a harmless first operation.
    while (position < tokens.length) {
      if (tokens[position++] !== 'fragment' || !name() || tokens[position++] !== 'on' || !name()) return null;
      directives(); group('{');
    }
    return { type, name:operationName, fields };
  } catch { return null; }
}
