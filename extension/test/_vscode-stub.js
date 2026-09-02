// @ts-check
'use strict';

/**
 * 확장 밖에서 모듈을 돌리기 위한 최소 `vscode` 스텁.
 *
 * 여러 테스트가 각자 스텁을 심으면 먼저 심은 것이 나중 것을 가려 설정 override 가
 * 안 먹는다(한 번 겪었다). 그래서 **하나의 config 객체를 공유**한다 — 어느 테스트가
 * 먼저 install 하든 같은 객체를 돌려받고, 그걸 수정하면 스텁이 즉시 반영한다.
 */

/** 테스트가 필요에 따라 바꿔 쓰는 설정값. */
const config = {
  timeoutMs: 5000,
  pythonPath: '',
  problemsRoot: '',
  claudePath: '',
  claudeModel: 'sonnet',
};

/**
 * `vscode` 를 require 캐시에 심는다. 이미 있으면 그대로 두고 공유 config 를 돌려준다.
 * @returns {typeof config}
 */
function install() {
  if (require.cache['vscode']) return config;

  const Module = require('node:module');
  const orig = Module._resolveFilename;
  Module._resolveFilename = function (/** @type {string} */ request, /** @type {any[]} */ ...rest) {
    if (request === 'vscode') return 'vscode';
    return orig.call(this, request, ...rest);
  };

  require.cache['vscode'] = /** @type {any} */ ({
    id: 'vscode',
    filename: 'vscode',
    loaded: true,
    exports: {
      workspace: {
        getConfiguration: () => ({ get: (/** @type {string} */ k) => /** @type {any} */ (config)[k] }),
      },
      extensions: { getExtension: () => undefined },
    },
  });

  return config;
}

module.exports = { config, install };
