/*
 * shims/d3d_translate.js — reflexão/layout D3D e parser de expressões HLSL.
 * Não é um compilador HLSL completo: declarações desconhecidas são rejeitadas.
 */
(function (global) {
  'use strict';

  const Porthole = (global.Porthole = global.Porthole || {});

  function unsupported(message, source, index) {
    let suffix = '';
    if (source && Number.isFinite(index)) {
      const before = source.slice(0, index);
      const line = before.split('\n').length;
      const column = index - before.lastIndexOf('\n');
      suffix = ` (linha ${line}, coluna ${column})`;
    }
    const error = new Error(`HLSL/D3D fora do subconjunto: ${message}${suffix}`);
    error.code = 'HLSL_UNSUPPORTED';
    throw error;
  }

  function stripComments(source) {
    return String(source || '').replace(/\/\*[\s\S]*?\*\//g, (text) => text.replace(/[^\n]/g, ' ')).replace(/\/\/[^\n]*/g, '');
  }

  const TYPES = {
    float: [4, 1], float1: [4, 1], float2: [8, 2], float3: [12, 3], float4: [16, 4],
    int: [4, 1], int1: [4, 1], int2: [8, 2], int3: [12, 3], int4: [16, 4],
    uint: [4, 1], uint1: [4, 1], uint2: [8, 2], uint3: [12, 3], uint4: [16, 4],
    bool: [4, 1],
  };
  for (const prefix of ['float', 'int', 'uint']) {
    for (let rows = 2; rows <= 4; rows += 1) {
      for (let columns = 2; columns <= 4; columns += 1) TYPES[`${prefix}${rows}x${columns}`] = [rows * 16, rows * columns];
    }
  }
  const align = (value, boundary) => Math.ceil(value / boundary) * boundary;

  function parseConstantBuffers(source) {
    const text = stripComments(source);
    const buffers = [];
    const registers = new Set();
    const declaration = /\bcbuffer\s+([A-Za-z_]\w*)\s*(?::\s*register\s*\(\s*b(\d+)\s*\)\s*)?\{/gi;
    for (let match = declaration.exec(text); match; match = declaration.exec(text)) {
      let cursor = declaration.lastIndex;
      let end = -1;
      for (; cursor < text.length; cursor += 1) {
        if (text[cursor] === '{') unsupported('blocos aninhados em cbuffer', text, cursor);
        if (text[cursor] === '}') { end = cursor; break; }
      }
      if (end < 0) unsupported(`cbuffer ${match[1]} sem fechamento`, text, match.index);
      const register = match[2] == null ? buffers.length : Number(match[2]);
      if (registers.has(register)) unsupported(`register(b${register}) duplicado`, text, match.index);
      registers.add(register);
      const body = text.slice(declaration.lastIndex, end);
      const members = [];
      const names = new Set();
      let offset = 0;
      const memberPattern = /([A-Za-z_]\w*)\s+([A-Za-z_]\w*)\s*(?:\[\s*(\d+)\s*\])?\s*;/g;
      for (let member = memberPattern.exec(body); member; member = memberPattern.exec(body)) {
        const type = member[1].toLowerCase();
        const layout = TYPES[type];
        if (!layout) unsupported(`tipo ${member[1]} em cbuffer`, text, declaration.lastIndex + member.index);
        const name = member[2];
        if (names.has(name)) unsupported(`membro ${name} duplicado`, text, declaration.lastIndex + member.index);
        names.add(name);
        const count = member[3] == null ? 1 : Number(member[3]);
        if (!count || count > 65536) unsupported(`array ${name} inválido`, text, declaration.lastIndex + member.index);
        const matrix = /x/.test(type);
        const baseSize = layout[0];
        if (count > 1 || matrix || baseSize >= 16) offset = align(offset, 16);
        else if (offset % 16 + baseSize > 16) offset = align(offset, 16);
        const stride = count > 1 ? (matrix ? baseSize : 16) : baseSize;
        const size = count > 1 ? stride * count : baseSize;
        members.push({ name, type, offset, size, stride, count, components: layout[1] });
        offset += size;
      }
      // Remover todas as declarações reconhecidas impede que tokens
      // desconhecidos dentro do cbuffer passem silenciosamente.
      const remainder = body.replace(memberPattern, '').replace(/\s/g, '');
      if (remainder) unsupported(`declaração em cbuffer ${match[1]}`, text, declaration.lastIndex);
      buffers.push({ name: match[1], register, members, size: align(offset, 16) });
      declaration.lastIndex = end + 1;
      if (text.slice(end + 1).trimStart().startsWith(';')) declaration.lastIndex = text.indexOf(';', end + 1) + 1;
    }
    return buffers;
  }

  const DECL_TYPES = {
    0: ['FLOAT', 4, 1, false], 1: ['FLOAT', 8, 2, false], 2: ['FLOAT', 12, 3, false], 3: ['FLOAT', 16, 4, false],
    4: ['UNSIGNED_BYTE', 4, 4, true, 'bgra'], 5: ['UNSIGNED_BYTE', 4, 4, false], 6: ['SHORT', 4, 2, false],
    7: ['SHORT', 8, 4, false], 8: ['UNSIGNED_BYTE', 4, 4, true], 9: ['SHORT', 4, 2, true],
    10: ['SHORT', 8, 4, true], 11: ['UNSIGNED_SHORT', 4, 2, true], 12: ['UNSIGNED_SHORT', 8, 4, true],
    15: ['HALF_FLOAT', 4, 2, false], 16: ['HALF_FLOAT', 8, 4, false],
  };
  const DECL_NAMES = ['FLOAT1', 'FLOAT2', 'FLOAT3', 'FLOAT4', 'D3DCOLOR', 'UBYTE4', 'SHORT2', 'SHORT4', 'UBYTE4N', 'SHORT2N', 'SHORT4N', 'USHORT2N', 'USHORT4N'];
  const USAGES = ['POSITION', 'BLENDWEIGHT', 'BLENDINDICES', 'NORMAL', 'PSIZE', 'TEXCOORD', 'TANGENT', 'BINORMAL', 'TESSFACTOR', 'POSITIONT', 'COLOR', 'FOG', 'DEPTH', 'SAMPLE'];
  function declarationType(type) {
    if (typeof type === 'string') {
      const normalized = type.toUpperCase().replace(/^D3DDECLTYPE_/, '');
      const index = DECL_NAMES.indexOf(normalized);
      if (index >= 0) return DECL_TYPES[index];
      if (/^FLOAT16_[24]$/.test(normalized)) return DECL_TYPES[normalized.endsWith('2') ? 15 : 16];
      unsupported(`D3DDECLTYPE ${type}`);
    }
    if (!DECL_TYPES[Number(type)]) unsupported(`D3DDECLTYPE ${type}`);
    return DECL_TYPES[Number(type)];
  }

  function createVertexLayout(elements, strides) {
    if (!Array.isArray(elements) || !elements.length) throw new TypeError('Vertex declaration vazia.');
    const attributes = [];
    const extents = new Map();
    const semantics = new Set();
    for (const element of elements) {
      const type = declarationType(element.type);
      const stream = Number(element.stream || 0);
      const offset = Number(element.offset);
      const usage = typeof element.usage === 'string' ? element.usage.toUpperCase().replace(/^D3DDECLUSAGE_/, '') : USAGES[Number(element.usage || 0)];
      const usageIndex = Number(element.usageIndex || 0);
      if (!Number.isInteger(stream) || stream < 0 || stream > 15 || !Number.isInteger(offset) || offset < 0 || !usage || !Number.isInteger(usageIndex) || usageIndex < 0) {
        throw new TypeError('D3DVERTEXELEMENT9 inválido.');
      }
      if (Number(element.method || 0) !== 0) unsupported('D3DDECLMETHOD diferente de DEFAULT');
      const semantic = `${usage}${usageIndex}`;
      const key = `${stream}:${semantic}`;
      if (semantics.has(key)) throw new Error(`Semantic duplicada: ${key}.`);
      semantics.add(key);
      const name = `a_${semantic.toLowerCase()}_${stream}`;
      attributes.push({ name, semantic, stream, offset, glType: type[0], size: type[1], components: type[2], normalized: type[3], swizzle: type[4] || null });
      extents.set(stream, Math.max(extents.get(stream) || 0, offset + type[1]));
    }
    const streamStrides = {};
    for (const [stream, extent] of extents) {
      const supplied = typeof strides === 'number' && stream === 0 ? strides : strides && strides[stream];
      const stride = supplied == null ? align(extent, 4) : Number(supplied);
      if (!Number.isInteger(stride) || stride <= 0 || stride < extent) throw new Error(`Stride inválido para stream ${stream}.`);
      streamStrides[stream] = stride;
    }
    for (const attribute of attributes) attribute.stride = streamStrides[attribute.stream];
    attributes.sort((a, b) => a.stream - b.stream || a.offset - b.offset);
    return { attributes, strides: streamStrides };
  }

  function tokenize(source) {
    const tokens = [];
    const pattern = /\s*(?:(\d+\.\d*|\.\d+|\d+(?:[eE][+-]?\d+)?)([fFhH])?|([A-Za-z_]\w*)|(\|\||&&|==|!=|<=|>=|[+\-*/<>!().,]))/y;
    let index = 0;
    while (index < source.length) {
      pattern.lastIndex = index;
      const match = pattern.exec(source);
      if (!match) {
        if (/^\s+$/.test(source.slice(index))) break;
        unsupported(`token ${JSON.stringify(source.slice(index, index + 12))}`, source, index);
      }
      tokens.push({ value: match[1] || match[3] || match[4], number: Boolean(match[1]), index: match.index + (match[0].length - match[0].trimStart().length) });
      index = pattern.lastIndex;
    }
    return tokens;
  }

  const CONSTRUCTORS = { float: 'float', float2: 'vec2', float3: 'vec3', float4: 'vec4', int: 'int', int2: 'ivec2', int3: 'ivec3', int4: 'ivec4', uint: 'uint', uint2: 'uvec2', uint3: 'uvec3', uint4: 'uvec4', bool: 'bool' };
  const FUNCTIONS = { abs: [1, 'abs'], min: [2, 'min'], max: [2, 'max'], pow: [2, 'pow'], dot: [2, 'dot'], cross: [2, 'cross'], normalize: [1, 'normalize'], length: [1, 'length'], distance: [2, 'distance'], clamp: [3, 'clamp'], saturate: [1, 'clamp'], lerp: [3, 'mix'], frac: [1, 'fract'], floor: [1, 'floor'], ceil: [1, 'ceil'], sqrt: [1, 'sqrt'], rsqrt: [1, 'inversesqrt'], sin: [1, 'sin'], cos: [1, 'cos'], tan: [1, 'tan'], atan: [1, 'atan'], atan2: [2, 'atan'], exp: [1, 'exp'], exp2: [1, 'exp2'], log: [1, 'log'], log2: [1, 'log2'], ddx: [1, 'dFdx'], ddy: [1, 'dFdy'] };

  function translateExpression(source) {
    const text = stripComments(source).trim();
    if (!text) throw new TypeError('Expressão HLSL vazia.');
    const tokens = tokenize(text);
    let cursor = 0;
    const peek = () => tokens[cursor] && tokens[cursor].value;
    const take = (value) => { if (peek() !== value) unsupported(`esperado ${value || 'fim da expressão'}`, text, tokens[cursor] && tokens[cursor].index); return tokens[cursor++]; };
    function primary() {
      const token = tokens[cursor];
      if (!token) unsupported('expressão incompleta', text, text.length);
      if (token.value === '(') { take('('); const value = expression(); take(')'); return `(${value})`; }
      if (token.number) { cursor += 1; return token.value; }
      if (!/^[A-Za-z_]\w*$/.test(token.value)) unsupported(`token ${token.value}`, text, token.index);
      cursor += 1;
      let value = token.value;
      if (peek() === '(') {
        take('(');
        const args = [];
        if (peek() !== ')') do { args.push(expression()); } while (peek() === ',' && (take(','), true));
        take(')');
        if (value === 'mul') {
          if (args.length !== 2) unsupported('mul requer dois argumentos', text, token.index);
          value = `((${args[0]}) * (${args[1]}))`;
        } else if (value === 'mad') {
          if (args.length !== 3) unsupported('mad requer três argumentos', text, token.index);
          value = `((${args[0]}) * (${args[1]}) + (${args[2]}))`;
        } else if (CONSTRUCTORS[value]) {
          if (!args.length) unsupported(`${value} sem argumentos`, text, token.index);
          value = `${CONSTRUCTORS[value]}(${args.join(', ')})`;
        } else if (FUNCTIONS[value]) {
          const [arity, glsl] = FUNCTIONS[value];
          if (args.length !== arity) unsupported(`${value} requer ${arity} argumentos`, text, token.index);
          const actual = value === 'saturate' ? `clamp(${args[0]}, 0.0, 1.0)` : `${glsl}(${args.join(', ')})`;
          value = actual;
        } else unsupported(`função ${value}`, text, token.index);
      }
      while (peek() === '.') {
        take('.');
        const memberToken = tokens[cursor++];
        if (!memberToken || !/^[A-Za-z_]\w*$/.test(memberToken.value)) unsupported('membro inválido', text, token.index);
        value += `.${memberToken.value}`;
      }
      return value;
    }
    function unary() { if (['!', '-', '+'].includes(peek())) { const op = tokens[cursor++].value; return `${op}${unary()}`; } return primary(); }
    function binary(next, operators) {
      let left = next();
      while (operators.includes(peek())) { const op = tokens[cursor++].value; left = `(${left} ${op} ${next()})`; }
      return left;
    }
    const multiply = () => binary(unary, ['*', '/']);
    const add = () => binary(multiply, ['+', '-']);
    const compare = () => binary(add, ['<', '>', '<=', '>=']);
    const equal = () => binary(compare, ['==', '!=']);
    const logicalAnd = () => binary(equal, ['&&']);
    const expression = () => binary(logicalAnd, ['||']);
    const result = expression();
    if (cursor !== tokens.length) unsupported(`token ${peek()}`, text, tokens[cursor].index);
    return result;
  }

  Porthole.D3DTranslator = { parseConstantBuffers, createVertexLayout, translateExpression, stripComments };
})(typeof window !== 'undefined' ? window : globalThis);
