import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
export function loadScripts(...names) {
  for (const name of names) require(`../../js/${name}.js`);
  return globalThis.Porthole;
}

export function makeCanvas(width = 96, height = 96) {
  const context = {
    canvas: null,
    presents: 0,
    drawCalls: 0,
    fillStyle: '#000',
    strokeStyle: '#000',
    lineWidth: 1,
    createImageData(w, h) { return { width: w, height: h, data: new Uint8ClampedArray(w * h * 4) }; },
    putImageData(image) { this.lastImage = image; this.presents += 1; },
    drawImage() { this.drawCalls += 1; },
    fillRect() {}, beginPath() {}, moveTo() {}, lineTo() {}, stroke() {}, arc() {},
  };
  const canvas = {
    width, height,
    getContext(type) { return type === '2d' ? context : null; },
    toDataURL() { return 'data:image/png;base64,AA=='; },
  };
  context.canvas = canvas;
  return canvas;
}

export function triangleBytes(width = 96, height = 96) {
  const data = new Uint8Array(60);
  const view = new DataView(data.buffer);
  const vertices = [
    [width / 2, 3, 0xff3478f6],
    [width - 5, height - 5, 0xff5eead4],
    [5, height - 5, 0xffa78bfa],
  ];
  vertices.forEach((vertex, index) => {
    const offset = index * 20;
    view.setFloat32(offset, vertex[0], true);
    view.setFloat32(offset + 4, vertex[1], true);
    view.setFloat32(offset + 8, 0, true);
    view.setFloat32(offset + 12, 1, true);
    view.setUint32(offset + 16, vertex[2], true);
  });
  return data;
}

export function makeFile(relativePath, contents = 'MZ') {
  const bytes = typeof contents === 'string' ? new TextEncoder().encode(contents) : new Uint8Array(contents);
  return {
    name: relativePath.split('/').pop(),
    webkitRelativePath: relativePath,
    size: bytes.byteLength,
    lastModified: 1700000000000,
    async arrayBuffer() { return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength); },
  };
}

/* PE32 com uma seção e import table real. Nenhum teste executa o byte 0xC3. */
export function buildPE(imports = [
  { dll: 'kernel32.dll', functions: ['CreateFileA'] },
  { dll: 'd3d9.dll', functions: ['Direct3DCreate9'] },
]) {
  const bytes = new Uint8Array(0x1000);
  const view = new DataView(bytes.buffer);
  const u16 = (offset, value) => view.setUint16(offset, value, true);
  const u32 = (offset, value) => view.setUint32(offset, value >>> 0, true);
  const ascii = (offset, text, zero = true) => {
    for (let i = 0; i < text.length; i += 1) bytes[offset + i] = text.charCodeAt(i) & 0x7f;
    if (zero) bytes[offset + text.length] = 0;
    return offset + text.length + (zero ? 1 : 0);
  };
  const pe = 0x80, optional = pe + 24, section = optional + 0xe0;
  const raw = 0x400, rva = (offset) => offset - raw + 0x1000;
  u16(0, 0x5a4d); u32(0x3c, pe); u32(pe, 0x4550);
  u16(pe + 4, 0x14c); u16(pe + 6, 1); u16(pe + 20, 0xe0); u16(pe + 22, 0x0102);
  u16(optional, 0x10b); u32(optional + 16, 0x1000); u32(optional + 20, 0x1000);
  u32(optional + 28, 0x400000); u32(optional + 32, 0x1000); u32(optional + 36, 0x200);
  u32(optional + 56, 0x2000); u32(optional + 60, 0x400); u16(optional + 68, 3);
  u32(optional + 92, 16);
  ascii(section, '.text', false);
  u32(section + 8, 0xc00); u32(section + 12, 0x1000); u32(section + 16, 0xc00); u32(section + 20, raw);
  u32(section + 36, 0x60000020);
  bytes[raw] = 0xc3;

  const importOffset = 0x500;
  const descriptorBytes = (imports.length + 1) * 20;
  u32(optional + 96 + 8, rva(importOffset));
  u32(optional + 96 + 12, descriptorBytes);
  let thunkOffset = importOffset + descriptorBytes;
  const thunks = imports.map((descriptor) => {
    const current = thunkOffset;
    thunkOffset += (descriptor.functions.length + 1) * 4;
    return current;
  });
  let cursor = (thunkOffset + 1) & ~1;
  imports.forEach((descriptor, index) => {
    const descriptorOffset = importOffset + index * 20;
    const dllOffset = cursor;
    cursor = ascii(cursor, descriptor.dll);
    cursor = (cursor + 1) & ~1;
    u32(descriptorOffset, rva(thunks[index]));
    u32(descriptorOffset + 12, rva(dllOffset));
    u32(descriptorOffset + 16, rva(thunks[index]));
    descriptor.functions.forEach((fn, fnIndex) => {
      if (typeof fn === 'object' && fn.ordinal != null) {
        u32(thunks[index] + fnIndex * 4, 0x80000000 | fn.ordinal);
      } else {
        const name = typeof fn === 'string' ? fn : fn.name;
        const nameOffset = cursor;
        u16(nameOffset, fnIndex);
        cursor = ascii(nameOffset + 2, name);
        cursor = (cursor + 1) & ~1;
        u32(thunks[index] + fnIndex * 4, rva(nameOffset));
      }
    });
  });
  if (cursor > bytes.length) throw new Error('PE fixture excedeu o buffer.');
  return bytes.buffer;
}

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
