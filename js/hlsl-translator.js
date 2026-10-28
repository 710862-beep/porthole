/*
 * hlsl-translator.js — subconjunto HLSL deliberadamente pequeno.
 * O benchmark usa mapeamento manual do fixed-function pipeline. Estas regras
 * aceitam apenas shaders triviais e rejeitam tudo que não possa ser provado.
 */
(function (global) {
  'use strict';

  const Porthole = (global.Porthole = global.Porthole || {});

  function clean(source) {
    return String(source || '').replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '').trim().replace(/\s+/g, ' ');
  }

  function unsupported(message) {
    const error = new Error(`HLSL fora do subconjunto: ${message}`);
    error.code = 'HLSL_UNSUPPORTED';
    throw error;
  }

  function translateVertex(source) {
    const text = clean(source);
    const match = text.match(/^float4\s+main\s*\(\s*float4\s+(\w+)\s*:\s*POSITION\s*\)\s*:\s*(?:SV_POSITION|POSITION0?)\s*\{\s*return\s+(\w+)\s*;\s*\}\s*;?$/i);
    if (!match || match[1] !== match[2]) {
      unsupported('vertex aceito: float4 main(float4 p : POSITION) : SV_POSITION { return p; }');
    }
    // A ABI do GTL usa posição em screen space, como D3DFVF_XYZRHW.
    return Porthole.GraphicsUtils.FIXED_VERTEX;
  }

  function translatePixel(source) {
    const text = clean(source);
    const match = text.match(/^float4\s+main\s*\(\s*\)\s*:\s*(?:COLOR0?|SV_TARGET0?)\s*\{\s*return\s+float4\s*\(\s*([01](?:\.0+)?)\s*,\s*([01](?:\.0+)?)\s*,\s*([01](?:\.0+)?)\s*,\s*([01](?:\.0+)?)\s*\)\s*;\s*\}\s*;?$/i);
    if (!match) unsupported('pixel aceito: float4 main() : COLOR { return float4(r,g,b,a); }, com componentes 0 ou 1.');
    return `precision mediump float;\nvoid main() { gl_FragColor = vec4(${match.slice(1).map(Number).join(', ')}); }`;
  }

  function translate(source, stage) {
    if (stage === 'vertex' || stage === 'vs') return translateVertex(source);
    if (stage === 'pixel' || stage === 'fragment' || stage === 'ps') return translatePixel(source);
    throw new TypeError('stage deve ser vertex ou pixel.');
  }

  Porthole.HLSLTranslator = { translate, translateVertex, translatePixel };
})(typeof window !== 'undefined' ? window : globalThis);
