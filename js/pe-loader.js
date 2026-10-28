/*
 * pe-loader.js — parser PE/COFF defensivo (cabeçalhos, seções e imports).
 * O resultado é uma descrição da imagem. Não há execução de entry point neste
 * arquivo e nenhum estado deste parser deve ser apresentado como “programa rodando”.
 */
(function (global) {
  'use strict';

  const Porthole = (global.Porthole = global.Porthole || {});

  class PEError extends Error {
    constructor(code, message, offset) {
      super(message);
      this.name = 'PEError';
      this.code = code;
      this.offset = offset == null ? null : offset;
    }
  }

  const MAX_SECTIONS = 96;
  const MAX_DESCRIPTORS = 512;
  const MAX_THUNKS_PER_DLL = 8192;
  const MAX_TOTAL_IMPORTS = 32768;
  const MAX_STRING = 4096;

  function parse(buffer, options) {
    const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const length = bytes.byteLength;
    const opts = options || {};

    function ensure(offset, size, label) {
      if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(size) || offset < 0 || size < 0 || offset + size > length) {
        throw new PEError('TRUNCATED', `PE truncado ao ler ${label || 'dados'} (offset ${offset}, tamanho ${size}).`, offset);
      }
    }
    const u8 = (offset, label) => { ensure(offset, 1, label); return view.getUint8(offset); };
    const u16 = (offset, label) => { ensure(offset, 2, label); return view.getUint16(offset, true); };
    const u32 = (offset, label) => { ensure(offset, 4, label); return view.getUint32(offset, true); };
    const u64 = (offset, label) => { ensure(offset, 8, label); return view.getBigUint64(offset, true); };

    function stringAt(offset, limit, label) {
      ensure(offset, 1, label || 'string');
      let end = offset;
      const max = Math.min(length, offset + (limit || MAX_STRING));
      while (end < max && u8(end) !== 0) end += 1;
      if (end === max && (max === length || u8(max - 1) !== 0)) {
        if (end - offset >= (limit || MAX_STRING)) throw new PEError('INVALID_STRING', `String não terminada em ${offset}.`, offset);
      }
      return new TextDecoder('ascii').decode(bytes.subarray(offset, end));
    }

    ensure(0, 64, 'DOS header');
    if (u16(0) !== 0x5a4d) throw new PEError('NOT_PE', 'Assinatura MZ ausente; isto não é um executável PE.', 0);
    const peOffset = u32(0x3c, 'e_lfanew');
    ensure(peOffset, 24, 'NT headers');
    if (u32(peOffset) !== 0x00004550) throw new PEError('NOT_PE', 'Assinatura PE\\0\\0 ausente.', peOffset);

    const coff = peOffset + 4;
    const machine = u16(coff);
    const sectionCount = u16(coff + 2);
    const optionalSize = u16(coff + 16);
    const characteristics = u16(coff + 18);
    if (!sectionCount || sectionCount > MAX_SECTIONS) throw new PEError('INVALID_SECTIONS', `Número inválido de seções: ${sectionCount}.`);
    const optional = coff + 20;
    ensure(optional, optionalSize, 'optional header');
    const magic = u16(optional);
    const isPlus = magic === 0x20b;
    if (magic !== 0x10b && !isPlus) throw new PEError('UNSUPPORTED_PE', `Optional header 0x${magic.toString(16)} não suportado.`);
    const architecture = machine === 0x14c ? 'x86' : machine === 0x8664 ? 'x64' : machine === 0xaa64 ? 'ARM64' : `machine_0x${machine.toString(16)}`;
    if ((machine === 0x14c && isPlus) || (machine === 0x8664 && !isPlus)) {
      throw new PEError('INVALID_PE', 'Machine e optional header divergem.');
    }

    const entryPointRva = u32(optional + 16);
    const imageBase = isPlus ? u64(optional + 24) : BigInt(u32(optional + 28));
    const sectionAlignment = u32(optional + 32);
    const sizeOfImage = u32(optional + 56);
    const sizeOfHeaders = u32(optional + 60);
    const directoryCountOffset = optional + (isPlus ? 108 : 92);
    const directoriesOffset = optional + (isPlus ? 112 : 96);
    ensure(directoryCountOffset, 4, 'NumberOfRvaAndSizes');
    const directoryCount = Math.min(u32(directoryCountOffset), 16);
    const importRva = directoryCount > 1 ? u32(directoriesOffset + 8) : 0;
    const importSize = directoryCount > 1 ? u32(directoriesOffset + 12) : 0;

    const sectionTable = optional + optionalSize;
    ensure(sectionTable, sectionCount * 40, 'section table');
    const sections = [];
    for (let index = 0; index < sectionCount; index += 1) {
      const offset = sectionTable + index * 40;
      const nameBytes = bytes.subarray(offset, offset + 8);
      let nameEnd = nameBytes.indexOf(0);
      if (nameEnd < 0) nameEnd = 8;
      const name = new TextDecoder('ascii').decode(nameBytes.subarray(0, nameEnd));
      const virtualSize = u32(offset + 8);
      const virtualAddress = u32(offset + 12);
      const rawSize = u32(offset + 16);
      const rawOffset = u32(offset + 20);
      if (rawSize) ensure(rawOffset, rawSize, `dados da seção ${name}`);
      sections.push({
        name, virtualSize, virtualAddress, rawSize, rawOffset,
        characteristics: u32(offset + 36),
      });
    }

    function rvaToOffset(rva, label) {
      if (!rva) return 0;
      if (rva < sizeOfHeaders && rva < length) return rva;
      for (const section of sections) {
        const span = Math.max(section.virtualSize, section.rawSize);
        if (rva >= section.virtualAddress && rva < section.virtualAddress + span) {
          const delta = rva - section.virtualAddress;
          if (delta >= section.rawSize) throw new PEError('UNMAPPED_RVA', `${label || 'RVA'} aponta para dados não presentes no arquivo.`, rva);
          const offset = section.rawOffset + delta;
          ensure(offset, 1, label);
          return offset;
        }
      }
      throw new PEError('INVALID_RVA', `RVA 0x${rva.toString(16)} não pertence a nenhuma seção (${label || 'dado'}).`, rva);
    }

    const imports = [];
    let totalImports = 0;
    if (importRva) {
      const thunkSize = isPlus ? 8 : 4;
      const ordinalFlag = isPlus ? 0x8000000000000000n : 0x80000000n;
      let descriptorIndex = 0;
      while (descriptorIndex < MAX_DESCRIPTORS) {
        const descriptorRva = importRva + descriptorIndex * 20;
        const descriptor = rvaToOffset(descriptorRva, 'import descriptor');
        ensure(descriptor, 20, 'import descriptor');
        const originalFirstThunk = u32(descriptor);
        const timeDateStamp = u32(descriptor + 4);
        const forwarderChain = u32(descriptor + 8);
        const nameRva = u32(descriptor + 12);
        const firstThunk = u32(descriptor + 16);
        if (!(originalFirstThunk || timeDateStamp || forwarderChain || nameRva || firstThunk)) break;
        if (!nameRva) throw new PEError('INVALID_IMPORT', 'Import descriptor sem nome de DLL.', descriptor);
        const dll = stringAt(rvaToOffset(nameRva, 'DLL name'), MAX_STRING, 'DLL name');
        const lookupRva = originalFirstThunk || firstThunk;
        const functions = [];
        if (lookupRva) {
          for (let thunkIndex = 0; thunkIndex < MAX_THUNKS_PER_DLL; thunkIndex += 1) {
            const thunkRva = lookupRva + thunkIndex * thunkSize;
            const thunkOffset = rvaToOffset(thunkRva, `thunk de ${dll}`);
            ensure(thunkOffset, thunkSize, 'import thunk');
            const value = isPlus ? u64(thunkOffset) : BigInt(u32(thunkOffset));
            if (value === 0n) break;
            if (thunkIndex === MAX_THUNKS_PER_DLL - 1) throw new PEError('IMPORT_LIMIT', `Thunk sem terminador em ${dll}.`);
            if ((value & ordinalFlag) !== 0n) {
              const ordinal = Number(value & 0xffffn);
              functions.push({ name: null, ordinal, hint: null });
            } else {
              const nameRvaFromThunk = Number(value & 0xffffffffn);
              const importNameOffset = rvaToOffset(nameRvaFromThunk, `import name de ${dll}`);
              const hint = u16(importNameOffset);
              const name = stringAt(importNameOffset + 2, MAX_STRING, 'imported symbol');
              functions.push({ name, ordinal: null, hint });
            }
            totalImports += 1;
            if (totalImports > MAX_TOTAL_IMPORTS) throw new PEError('IMPORT_LIMIT', 'O PE excede o limite de imports analisados.');
          }
        }
        imports.push({ dll, functions, originalFirstThunk, firstThunk });
        descriptorIndex += 1;
        if (descriptorIndex === MAX_DESCRIPTORS) throw new PEError('IMPORT_LIMIT', 'Import directory sem terminador.');
      }
    }

    let entryPointOffset = null;
    if (entryPointRva) {
      try { entryPointOffset = rvaToOffset(entryPointRva, 'entry point'); } catch (_) { entryPointOffset = null; }
    }
    const machineSupported = machine === 0x14c || machine === 0x8664;
    if (!machineSupported && !opts.allowUnknownMachine) {
      throw new PEError('UNSUPPORTED_MACHINE', `Arquitetura ${architecture} não suportada pelo loader.`);
    }

    return {
      name: opts.name || null,
      byteLength: length,
      format: isPlus ? 'PE32+' : 'PE32',
      architecture,
      machine,
      characteristics,
      isDLL: Boolean(characteristics & 0x2000),
      imageBase: `0x${imageBase.toString(16)}`,
      entryPointRva,
      entryPointOffset,
      sectionAlignment,
      sizeOfImage,
      sizeOfHeaders,
      sections,
      imports,
      importDirectory: { rva: importRva, size: importSize },
      // Explícito para impedir que consumidores confundam parsing com execução.
      execution: { executed: false, backend: null, reason: 'Nenhum executor x86/x64 em user mode configurado.' },
    };
  }

  Porthole.PEError = PEError;
  Porthole.PELoader = { parse };
})(typeof window !== 'undefined' ? window : globalThis);
