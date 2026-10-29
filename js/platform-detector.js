/*
 * platform-detector.js — sistema operacional e capacidades do navegador.
 *
 * A detecção prioriza User-Agent Client Hints, mas cruza userAgent/platform
 * para navegadores antigos. ChromeOS precisa ser testado antes de Linux.
 * Suporte a filesystem/WebGL é detectado por capacidade, nunca deduzido do SO.
 */
(function (global) {
  'use strict';

  const Porthole = (global.Porthole = global.Porthole || {});

  const HOST_PATHS = Object.freeze({
    linux: '~/Documents (ou qualquer pasta selecionada)',
    windows: 'C:\\Users\\<usuário>\\Documents (ou pasta selecionada)',
    chromeos: '/home/chronos/u-<hash>/MyFiles/Downloads (ou pasta selecionada)',
    macos: '~/Documents (ou qualquer pasta selecionada)',
    unknown: 'Pasta selecionada pelo usuário',
  });

  function browserName(userAgent) {
    const ua = String(userAgent || '');
    if (/Edg\//.test(ua)) return 'Edge';
    if (/Firefox\//.test(ua)) return 'Firefox';
    if (/Chrome\//.test(ua) && !/Edg\//.test(ua)) return 'Chrome';
    if (/Safari\//.test(ua) && !/Chrome\//.test(ua)) return 'Safari';
    return 'Navegador';
  }

  function detect(navigatorLike, windowLike) {
    const nav = navigatorLike || {};
    const win = windowLike || {};
    const ua = String(nav.userAgent || '');
    const legacyPlatform = String(nav.platform || '');
    // userAgentData.platform é menos sujeito ao congelamento/redução do UA.
    const hintPlatform = String(nav.userAgentData && nav.userAgentData.platform || '');
    const fingerprint = `${hintPlatform} ${legacyPlatform} ${ua}`;

    let id = 'unknown';
    let label = 'Sistema não identificado';
    if (/CrOS/i.test(fingerprint)) {
      id = 'chromeos';
      label = 'ChromeOS';
    } else if (/Win(?:dows|32|64|NT)/i.test(fingerprint) || /^Win/i.test(hintPlatform)) {
      id = 'windows';
      label = 'Windows';
    } else if (/mac(?:intosh|intel| os x)|MacIntel|MacPPC/i.test(fingerprint) || /^macOS$/i.test(hintPlatform)) {
      id = 'macos';
      label = 'macOS';
    } else if (/Linux|X11/i.test(fingerprint)) {
      id = 'linux';
      label = 'Linux';
    } else if (/Android/i.test(fingerprint)) {
      id = 'linux';
      label = 'Linux / Android';
    }

    const hasPicker = typeof win.showDirectoryPicker === 'function';
    const secureContext = win.isSecureContext === true;
    const capabilities = {
      // A API só é utilizável em contexto seguro; localhost também é seguro.
      fileSystemAccess: hasPicker && secureContext,
      directoryPickerVisible: hasPicker,
      secureContext,
      directoryInput: typeof win.document === 'object' && win.document !== null,
      indexedDB: typeof win.indexedDB === 'object' && win.indexedDB !== null,
      webgl: typeof win.HTMLCanvasElement === 'function',
      userAgentData: Boolean(nav.userAgentData),
    };

    return {
      id,
      label,
      browser: browserName(ua),
      hostPath: HOST_PATHS[id],
      capabilities,
      evidence: {
        userAgentDataPlatform: hintPlatform || null,
        platform: legacyPlatform || null,
        userAgent: ua || null,
      },
    };
  }

  Porthole.PlatformDetector = { detect, HOST_PATHS };
  // Em Node, global.navigator pode existir; nenhum DOM é exigido aqui.
  Porthole.platform = detect(global.navigator, global);
})(typeof window !== 'undefined' ? window : globalThis);
