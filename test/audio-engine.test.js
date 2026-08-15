'use strict';
/* 音频引擎冒烟测试: 用最小 mock 模拟浏览器 Web Audio API, 验证 audio-engine.js 逻辑 */
const fs = require('fs');
const path = require('path');

// ---- Mock Web Audio API ----
function makeNode() {
  return {
    connect() {}, disconnect() {},
    gain: { value: 0, setValueAtTime() {}, linearRampToValueAtTime() {}, exponentialRampToValueAtTime() {} },
    frequency: { value: 0, setValueAtTime() {} },
    type: '', buffer: null, start() {}, stop() {},
    threshold: { value: 0 }, knee: { value: 0 }, ratio: { value: 0 },
    attack: { value: 0 }, release: { value: 0 }, Q: { value: 0 },
    getChannelData() { return new Float32Array(10); },
    createBuffer() { return { getChannelData: () => new Float32Array(10) }; }
  };
}
global.window = {
  AudioContext: class {
    constructor() { this.state = 'running'; this.currentTime = 0; this.sampleRate = 48000; this.destination = makeNode(); }
    createGain() { return makeNode(); }
    createOscillator() { return makeNode(); }
    createBufferSource() { return makeNode(); }
    createBiquadFilter() { return makeNode(); }
    createDynamicsCompressor() { return makeNode(); }
    createBuffer() { return { getChannelData: () => new Float32Array(10) }; }
    resume() { this.state = 'running'; }
  }
};

// 载入引擎
const code = fs.readFileSync(path.join(__dirname, '..', 'public', 'audio-engine.js'), 'utf8');
eval(code);

const A = window.AudioEngine;
let pass = 0, fail = 0;
const ok = (name, cond) => { if (cond) { pass++; console.log('  PASS', name); } else { fail++; console.log('  FAIL', name); } };

console.log('== 初始化 ==');
A.init();
ok('init 完成', A.isMuted() === false);

console.log('== 事件 API ==');
A.play('sfx:chips:raise');
A.play('sfx:table:deal_flop');
A.play('sfx:result:win');
A.play('sfx:ui:click');
A.play('sfx:notexist');  // 未知事件应仅告警不崩溃
ok('未知事件不崩溃', true);

console.log('== 随机化容器 (同一事件连发, pitch 应变化) ==');
const seen = new Set();
for (let i = 0; i < 50; i++) A.play('sfx:ui:click');
// 引擎内部随机, 这里验证 play 不抛异常
ok('50 次连发无异常', true);

console.log('== 张力参数 ==');
A.music.setTension(0.9);
ok('setTension(0.9) 生效', A.music.getTension() === 0.9);
A.music.setTension(5);  // 越界应 clamp
ok('越界 clamp 到 1', A.music.getTension() === 1);

console.log('== 风格切换 ==');
ok('setBGMStyle(jazz) 成功', A.setBGMStyle('jazz') === true);
ok('非法风格返回 false', A.setBGMStyle('nope') === false);
ok('getBGMInfo 有名字', typeof A.getBGMInfo().name === 'string');

console.log('== 开关/音量 ==');
A.toggleSFX();
ok('toggleSFX 关闭', A.isSFXOn() === false);
A.play('sfx:chips:call');  // 关闭时播放应无效果
A.toggleSFX();
ok('toggleSFX 恢复', A.isSFXOn() === true);
A.setBGMVolume(0.3);
ok('BGM 音量设置', Math.abs(A.getBGMVolume() - 0.3) < 1e-6);
A.setSFXVolume(0.5);
ok('SFX 音量设置', Math.abs(A.getSFXVolume() - 0.5) < 1e-6);
A.setUIVolume(0.2);
ok('UI 音量设置', Math.abs(A.getUIVolume() - 0.2) < 1e-6);

console.log('== 向后兼容别名 (v1 sfx API) ==');
A.sfx.click(); A.sfx.deal(); A.sfx.flop(); A.sfx.turn(); A.sfx.river();
A.sfx.chip(); A.sfx.fold(); A.sfx.check(); A.sfx.raise(); A.sfx.allin();
A.sfx.yourTurn(); A.sfx.win(); A.sfx.lose(); A.sfx.split(); A.sfx.reveal();
A.sfx.buyIn(); A.sfx.notify();
ok('17 个别名全部可调用', true);

console.log('== 静音 ==');
A.setMuted(true);
ok('静音生效', A.isMuted() === true);
A.setMuted(false);
ok('取消静音', A.isMuted() === false);

console.log(`\n结果: ${pass} 通过, ${fail} 失败`);
process.exit(fail > 0 ? 1 : 0);
