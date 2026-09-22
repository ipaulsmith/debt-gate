function isIdentifierStart(character) {
  return /[A-Za-z_$]/.test(character ?? '');
}

function isIdentifierPart(character) {
  return /[A-Za-z0-9_$]/.test(character ?? '');
}

export function executableTokens(source) {
  const tokens = [];
  let index = 0;
  let lineBreakBefore = false;

  const noteLineBreak = (character) => {
    if (character === '\n' || character === '\r') lineBreakBefore = true;
  };
  const push = (value) => {
    tokens.push({ value, lineBreakBefore });
    lineBreakBefore = false;
  };
  const skipQuoted = (quote) => {
    index += 1;
    while (index < source.length) {
      const character = source[index];
      noteLineBreak(character);
      index += 1;
      if (character === '\\') {
        noteLineBreak(source[index]);
        index += 1;
      } else if (character === quote) {
        return;
      }
    }
  };

  const scanCode = (stopAtTemplateBrace = false) => {
    let braceDepth = 0;
    while (index < source.length) {
      const character = source[index];
      const next = source[index + 1];

      if (/\s/.test(character)) {
        noteLineBreak(character);
        index += 1;
        continue;
      }
      if (character === '/' && next === '/') {
        index += 2;
        while (index < source.length && source[index] !== '\n' && source[index] !== '\r') index += 1;
        continue;
      }
      if (character === '/' && next === '*') {
        index += 2;
        while (index < source.length) {
          noteLineBreak(source[index]);
          if (source[index] === '*' && source[index + 1] === '/') {
            index += 2;
            break;
          }
          index += 1;
        }
        continue;
      }
      if (character === "'" || character === '"') {
        push('<literal>');
        skipQuoted(character);
        continue;
      }
      if (character === '`') {
        push('<template>');
        index += 1;
        while (index < source.length) {
          const templateCharacter = source[index];
          const templateNext = source[index + 1];
          noteLineBreak(templateCharacter);
          if (templateCharacter === '\\') {
            index += 2;
          } else if (templateCharacter === '`') {
            index += 1;
            break;
          } else if (templateCharacter === '$' && templateNext === '{') {
            index += 2;
            scanCode(true);
          } else {
            index += 1;
          }
        }
        continue;
      }
      if (isIdentifierStart(character)) {
        const start = index;
        index += 1;
        while (isIdentifierPart(source[index])) index += 1;
        push(source.slice(start, index));
        continue;
      }
      if (stopAtTemplateBrace && character === '}' && braceDepth === 0) {
        index += 1;
        return;
      }
      if (stopAtTemplateBrace && character === '{') braceDepth += 1;
      if (stopAtTemplateBrace && character === '}') braceDepth -= 1;
      push(character);
      index += 1;
    }
  };

  scanCode();
  return tokens;
}

export function hasCall(tokens, dottedCallee) {
  const expected = dottedCallee.split('.').flatMap((part, index) => index === 0 ? [part] : ['.', part]);
  expected.push('(');
  return tokens.some((_, start) => expected.every((value, offset) => tokens[start + offset]?.value === value));
}
