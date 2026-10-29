/* Test/automation input adapter. This is NOT a Windows DLL or physical input.
 * The target is the real Retrowin32Process; its Host bridge delivers WM_INPUT.
 */
(function(global){
  'use strict';
  class User32InputInjector {
    constructor(process){if(typeof process?.injectRawInput!=='function')throw new TypeError('Retrowin32Process required');this.process=process;}
    inject_test_input(dx,dy){this.process.injectRawInput(dx,dy);}
  }
  (global.Porthole=global.Porthole||{}).User32InputInjector=User32InputInjector;
})(globalThis);
