'use strict';
/* ============================================================
 * 德州扑克 · 专业音频引擎 v2.0
 * Web Audio 纯合成 | 事件化 API | 随机化容器 | 自适应音乐
 * ------------------------------------------------------------
 * 设计文档: docs/音频设计文档.md
 * 特性:
 *  - 总线分级: Master → (BGM / SFX / UI) + Dynamics 保护链
 *  - 事件注册表: AudioEngine.play('sfx:chips:raise')
 *  - 随机化容器: 音高/音量/速率 每发随机, 防听觉疲劳
 *  - 自适应音乐: Tension 参数 (0~1) 驱动分层
 *  - 向后兼容: 保留 v1 的 sfx.xxx() 别名
 * ============================================================ */

const AudioEngine = (() => {
  // ============ 状态 ============
  let ctx = null;
  let dynamics = null;      // Compressor + Limiter
  let masterGain = null;
  let bgmBus = null, sfxBus = null, uiBus = null;
  let muted = false;
  let bgmOn = true, sfxOn = true, uiOn = true;
  let initDone = false;

  // BGM 调度状态
  let bgmTimer = null;
  let nextNoteTime = 0;
  let noteIndex = 0;
  let bgmStyle = 'piano';
  let tension = 0;          // 0~1 张力参数 (目标值)
  let tensionCur = 0;       // 当前平滑值
  let tensionAnim = null;

  // 歌曲模式 (music/ 目录下的 mp3): 有歌优先播放歌曲, 无歌回退合成 BGM
  let songList = [];
  let songAudio = null;     // <audio> 元素
  let songGain = null;      // 歌曲独立增益 (mp3 响度高于合成, 单独放大)
  let songOn = false;       // 当前是否在播歌
  let songIndex = 0;        // 当前播放的歌曲下标
  let songProgressTimer = null; // 进度轮询定时器
  let songListeners = [];   // 进度变化回调 [fn(progress{cur,dur,song})]
  let bgmStyleUserSet = false;  // 用户是否手动选过风格 (决定歌曲是否自动接管)

  // 语音预算: 记录活跃 SFX 数量
  let activeVoices = 0;
  const MAX_SFX_VOICES = 16;
  const MAX_BGM_VOICES = 8;

  // ============ 随机工具 ============
  const rand = (min, max) => min + Math.random() * (max - min);
  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

  // ============ 初始化 ============
  function init() {
    if (initDone) return;
    try {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return;
      ctx = new AC();

      // --- 总线架构 ---
      masterGain = ctx.createGain();
      masterGain.gain.value = 0.9;

      // Dynamics 保护链: Compressor → Limiter (防削波)
      const comp = ctx.createDynamicsCompressor();
      comp.threshold.value = -12;
      comp.knee.value = 6;
      comp.ratio.value = 4;
      comp.attack.value = 0.003;
      comp.release.value = 0.25;

      // Limiter: 用 Compressor 高比率近似, 或直接 master gain ceiling
      masterGain.connect(comp);
      comp.connect(ctx.destination);

      // 三条子总线
      bgmBus = ctx.createGain(); bgmBus.gain.value = 0.16; bgmBus.connect(masterGain);
      sfxBus = ctx.createGain(); sfxBus.gain.value = 0.7;  sfxBus.connect(masterGain);
      uiBus  = ctx.createGain(); uiBus.gain.value = 0.35;  uiBus.connect(masterGain);

      initDone = true;
      // AudioContext 解锁(用户手势 resume)成功后: 自动补播被自动播放策略拦截的歌曲
      ctx.onstatechange = () => { retrySongIfNeeded(); };
      if (bgmOn) startBGM();
      loadSongList();   // 探测 music/ 目录歌曲 (异步, 有歌且用户未手动选风格时自动切到歌曲模式)
    } catch (e) {
      console.warn('音频初始化失败', e);
    }
  }

  function resume() {
    if (ctx && ctx.state === 'suspended') ctx.resume();
    // 解锁成功(用户手势)后: 重试之前被自动播放策略拦截的歌曲
    // (iOS 的 pointerdown 可能不解锁音频, touchend/keydown 等手势解锁后在此补播)
    retrySongIfNeeded();
  }

  // 歌曲重试: 曾因自动播放策略/加载失败回退合成, 解锁(或新歌曲就绪)后自动切回歌曲模式
  let _songRetryPending = false;   // 有待重试的歌曲播放
  let _songWanted = false;         // 用户/自动逻辑仍期望歌曲模式 (回退后仍保持, 解锁即恢复)
  function retrySongIfNeeded() {
    if (_songRetryPending && _songWanted && bgmOn && songList.length > 0 && ctx && ctx.state === 'running') {
      _songRetryPending = false;
      bgmStyle = 'song';
      try { playSong(); } catch (e) {}
    }
  }

  // ============ 基础合成原语 ============
  /**
   * 播放一个音符 (带攻击/释放包络)
   * @param {number} freq  频率 Hz
   * @param {number} dur   持续秒
   * @param {string} type  波形
   * @param {number} gain  峰值增益
   * @param {number} when  延迟秒
   * @param {AudioNode} dest 输出目标
   */
  function tone(freq, dur, type = 'sine', gain = 0.5, when = 0, dest = null) {
    if (!ctx) return;
    const t = ctx.currentTime + (when || 0);
    const osc = ctx.createOscillator();
    const g = ctx.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(freq, t);
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(gain, t + 0.015);   // attack
    g.gain.exponentialRampToValueAtTime(0.001, t + dur); // release
    osc.connect(g);
    g.connect(dest || sfxBus);
    osc.start(t);
    osc.stop(t + dur + 0.05);
  }

  /** 噪声 (带通滤波) */
  function noise(dur, gain = 0.3, when = 0, freq = 3000, dest = null) {
    if (!ctx) return;
    const t = ctx.currentTime + (when || 0);
    const len = Math.max(1, Math.floor(ctx.sampleRate * dur));
    const buf = ctx.createBuffer(1, len, ctx.sampleRate);
    const data = buf.getChannelData(0);
    for (let i = 0; i < len; i++) data[i] = (Math.random() * 2 - 1) * (1 - i / len);
    const src = ctx.createBufferSource();
    src.buffer = buf;
    const filter = ctx.createBiquadFilter();
    filter.type = 'bandpass';
    filter.frequency.value = freq;
    filter.Q.value = 1.2;
    const g = ctx.createGain();
    g.gain.setValueAtTime(gain, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + dur);
    src.connect(filter); filter.connect(g); g.connect(dest || sfxBus);
    src.start(t);
  }

  // ============ 语音预算 ============
  function voiceEnter() { activeVoices++; }
  function voiceLeave() { activeVoices = Math.max(0, activeVoices - 1); }
  function voiceAvailable() { return activeVoices < MAX_SFX_VOICES; }

  // ============ 事件注册表 (随机化容器) ============
  /**
   * 每个事件: 合成函数 + 随机化范围
   * variation 每发随机, 保证"没有两个音效完全相同"
   */
  const EVENTS = {
    // ---- 发牌/公共牌 ----
    'sfx:table:deal': {
      voices: 2,
      play({ v }) {
        if (!voiceAvailable()) return;
        voiceEnter();
        noise(0.12 * v.rate, 0.25, 0, 4200 * v.pitch);
        tone(1800 * v.pitch, 0.05, 'sine', 0.2, 0.03);
        setTimeout(voiceLeave, 400);
      },
      variation: { pitch: [0.95, 1.05], gain: [-3, 3], rate: [0.9, 1.1] }
    },
    'sfx:table:deal_flop': {
      voices: 2,
      play({ v }) {
        if (!voiceAvailable()) return;
        voiceEnter();
        // 三连发牌 + 轻微上扬
        for (let i = 0; i < 3; i++) {
          noise(0.12 * v.rate, 0.25, i * 0.14, 4000 * v.pitch * (1 + i * 0.03));
          tone(1700 * v.pitch * (1 + i * 0.05), 0.05, 'sine', 0.18, i * 0.14);
        }
        setTimeout(voiceLeave, 600);
      },
      variation: { pitch: [0.96, 1.04], gain: [-2, 2], rate: [0.92, 1.08] }
    },
    'sfx:table:deal_turn': {
      voices: 2,
      play({ v }) {
        if (!voiceAvailable()) return;
        voiceEnter();
        noise(0.12 * v.rate, 0.26, 0, 4200 * v.pitch);
        tone(440, 0.2, 'triangle', 0.3, 0.02);
        tone(554, 0.25, 'triangle', 0.25, 0.12);
        setTimeout(voiceLeave, 500);
      },
      variation: { pitch: [0.97, 1.03], gain: [-2, 2], rate: [0.95, 1.05] }
    },
    'sfx:table:deal_river': {
      voices: 2,
      play({ v }) {
        if (!voiceAvailable()) return;
        voiceEnter();
        noise(0.12 * v.rate, 0.27, 0, 4400 * v.pitch);
        tone(494, 0.22, 'triangle', 0.3, 0.02);
        tone(622, 0.28, 'triangle', 0.28, 0.13);
        tone(740, 0.2, 'sine', 0.12, 0.24);
        setTimeout(voiceLeave, 550);
      },
      variation: { pitch: [0.97, 1.03], gain: [-2, 2], rate: [0.95, 1.05] }
    },

    // ---- 筹码 ----
    'sfx:chips:call': {
      voices: 1,
      play({ v }) {
        if (!voiceAvailable()) return;
        voiceEnter();
        tone(1046 * v.pitch, 0.08, 'square', 0.12);
        tone(1318 * v.pitch, 0.1, 'square', 0.1, 0.05);
        noise(0.05, 0.15, 0, 5000);
        setTimeout(voiceLeave, 300);
      },
      variation: { pitch: [0.97, 1.03], gain: [-2, 2], rate: [0.95, 1.05] }
    },
    'sfx:chips:raise': {
      voices: 1,
      play({ v }) {
        if (!voiceAvailable()) return;
        voiceEnter();
        tone(1046 * v.pitch, 0.08, 'square', 0.13);
        tone(1318 * v.pitch, 0.1, 'square', 0.12, 0.05);
        tone(1568 * v.pitch, 0.12, 'square', 0.1, 0.1);
        noise(0.06, 0.18, 0, 5200);
        setTimeout(voiceLeave, 350);
      },
      variation: { pitch: [0.98, 1.02], gain: [-2, 2], rate: [0.96, 1.04] }
    },
    'sfx:chips:allin': {
      voices: 0, // 最高优先, 不占普通预算
      play({ v }) {
        // 筹码倾泻: 多枚叠加
        for (let i = 0; i < 8; i++) {
          tone(1200 * rand(0.9, 1.1), 0.06, 'square', 0.1, i * 0.045);
          noise(0.05, 0.12, i * 0.045, 5600);
        }
        // 低频冲击 (张力时刻)
        tone(110, 0.5, 'sine', 0.4, 0);
        tone(55, 0.6, 'sine', 0.3, 0.02);
        // 上行张力琶音
        [220, 277, 330].forEach((f, i) => tone(f, 0.2, 'triangle', 0.22, 0.1 + i * 0.06));
      },
      variation: { pitch: [0.98, 1.02], gain: [-1, 1], rate: [0.97, 1.03] }
    },

    // ---- 玩家行动 ----
    'sfx:player:fold': {
      voices: 1,
      play({ v }) {
        if (!voiceAvailable()) return;
        voiceEnter();
        noise(0.08, 0.14, 0, 3200 * v.pitch);      // 收牌擦声
        tone(330, 0.25, 'sawtooth', 0.12, 0.02);
        tone(196, 0.3, 'sine', 0.2, 0.07);
        setTimeout(voiceLeave, 400);
      },
      variation: { pitch: [0.96, 1.04], gain: [-3, 3], rate: [0.9, 1.1] }
    },
    'sfx:player:check': {
      voices: 1,
      play({ v }) {
        if (!voiceAvailable()) return;
        voiceEnter();
        noise(0.04, 0.12, 0, 2600);                 // 轻敲桌面
        tone(880 * v.pitch, 0.05, 'sine', 0.1, 0.01);
        setTimeout(voiceLeave, 200);
      },
      variation: { pitch: [0.95, 1.05], gain: [-2, 2], rate: [0.9, 1.1] }
    },

    // ---- 结果 ----
    'sfx:result:reveal': {
      voices: 0,
      play({ v }) {
        // 揭示闪光: 张力停顿 + 上行
        tone(622, 0.3, 'triangle', 0.28, 0);
        tone(830, 0.3, 'triangle', 0.26, 0.1);
        tone(1244, 0.4, 'triangle', 0.2, 0.2);
      },
      variation: { pitch: [0.99, 1.01], gain: [-1, 1], rate: [0.99, 1.01] }
    },
    'sfx:result:win': {
      voices: 0,
      play({ v }) {
        const notes = [523, 659, 784, 1046, 1318];
        notes.forEach((f, i) => tone(f, 0.25, 'triangle', 0.3, i * 0.12));
        tone(65, 0.8, 'sine', 0.18, 0);             // 低音根音支撑
      },
      variation: { pitch: [0.99, 1.01], gain: [-1, 1], rate: [1, 1] }
    },
    'sfx:result:lose': {
      voices: 0,
      play({ v }) {
        const notes = [392, 330, 262, 196];
        notes.forEach((f, i) => tone(f, 0.28, 'sine', 0.22, i * 0.15));
      },
      variation: { pitch: [0.99, 1.01], gain: [-1, 1], rate: [1, 1] }
    },
    'sfx:result:split': {
      voices: 0,
      play({ v }) {
        tone(440, 0.2, 'triangle', 0.25);
        tone(554, 0.25, 'triangle', 0.22, 0.1);
      },
      variation: { pitch: [0.99, 1.01], gain: [-1, 1], rate: [1, 1] }
    },

    // ---- UI ----
    'sfx:ui:click': {
      voices: 3,
      play({ v }) {
        tone(880 * v.pitch, 0.06, 'square', 0.12, 0, uiBus);
      },
      variation: { pitch: [0.92, 1.08], gain: [-2, 2], rate: [0.9, 1.1] }
    },
    'sfx:ui:your_turn': {
      voices: 0, // 最高优先
      play({ v }) {
        tone(660, 0.12, 'sine', 0.25, 0, uiBus);
        tone(880, 0.16, 'sine', 0.25, 0.09, uiBus);
        tone(1100, 0.2, 'sine', 0.22, 0.18, uiBus);
      },
      variation: { pitch: [0.99, 1.01], gain: [-1, 1], rate: [1, 1] }
    },
    'sfx:ui:notify': {
      voices: 3,
      play({ v }) {
        tone(988 * v.pitch, 0.08, 'sine', 0.1, 0, uiBus);
      },
      variation: { pitch: [0.96, 1.04], gain: [-2, 2], rate: [0.95, 1.05] }
    },
    'sfx:ui:buyin': {
      voices: 1,
      play({ v }) {
        tone(784, 0.1, 'triangle', 0.25, 0, uiBus);
        tone(988, 0.14, 'triangle', 0.25, 0.08, uiBus);
        tone(1318, 0.2, 'triangle', 0.22, 0.16, uiBus);
      },
      variation: { pitch: [0.98, 1.02], gain: [-2, 2], rate: [0.97, 1.03] }
    }
  };

  // ============ 事件播放 ============
  /**
   * 统一事件入口: AudioEngine.play('sfx:chips:raise')
   * 自动应用随机化容器
   */
  function play(eventPath) {
    if (!ctx || muted || !sfxOn && !eventPath.startsWith('sfx:ui:')) {
      // UI 事件由 uiOn 控制, 玩法由 sfxOn 控制
    }
    const ev = EVENTS[eventPath];
    if (!ev) { console.warn('[Audio] 未知事件:', eventPath); return; }

    // 路由到对应总线开关
    if (eventPath.startsWith('sfx:ui:')) { if (!uiOn) return; }
    else { if (!sfxOn) return; }

    // 应用随机化
    const v = { pitch: 1, gain: 0, rate: 1 };
    if (ev.variation) {
      v.pitch = rand(ev.variation.pitch[0], ev.variation.pitch[1]);
      v.gain = rand(ev.variation.gain[0], ev.variation.gain[1]);
      v.rate = rand(ev.variation.rate[0], ev.variation.rate[1]);
    }
    try { ev.play({ v }); } catch (e) { console.warn('[Audio] 事件执行失败', eventPath, e); }
  }

  // ============ 背景音乐: 自适应分层 ============
  const BGM_STYLES = {
    piano: {
      name: '舒缓钢琴',
      chords: [
        [220, 261.63, 329.63],      // Am
        [174.61, 220, 261.63],      // F
        [261.63, 329.63, 392],      // C
        [196, 246.94, 293.66]       // G
      ],
      noteDur: 0.42, step: 0.46, type: 'sine',
      arpGain: 0.5, bassGain: 0.4, sparkle: false
    },
    jazz: {
      name: '轻快爵士',
      chords: [
        [220, 261.63, 329.63, 415.3],  // Am7
        [174.61, 220, 261.63, 349.23], // Fmaj7
        [196, 246.94, 293.66, 392],    // G7
        [164.81, 220, 261.63, 329.63]  // Em7
      ],
      noteDur: 0.22, step: 0.26, type: 'triangle',
      arpGain: 0.45, bassGain: 0.35, sparkle: true
    },
    electro: {
      name: '电子律动',
      chords: [
        [220, 277.18, 329.63],      // Am 电子感
        [174.61, 233.08, 261.63],
        [261.63, 311.13, 392],
        [196, 246.94, 293.66]
      ],
      noteDur: 0.14, step: 0.18, type: 'square',
      arpGain: 0.32, bassGain: 0.3, sparkle: true
    }
  };

  function startBGM() {
    if (!ctx || bgmTimer || !bgmOn) return;
    // 歌曲模式: 有歌且当前风格为 song → 播放歌曲而非合成
    if (bgmStyle === 'song' && songList.length > 0) {
      playSong();
      return;
    }
    nextNoteTime = ctx.currentTime + 0.1;
    noteIndex = 0;
    const st = BGM_STYLES[bgmStyle] || BGM_STYLES.piano;
    bgmTimer = setInterval(() => {
      if (muted || !bgmOn) return;
      if (!ctx || ctx.state !== 'running') return;
      // 平滑张力
      if (Math.abs(tensionCur - tension) > 0.005) {
        tensionCur += (tension - tensionCur) * 0.15;
      }
      // 前瞻调度
      while (nextNoteTime < ctx.currentTime + 0.3) {
        scheduleBGMNote(st, nextNoteTime);
        nextNoteTime += st.step;
        noteIndex++;
      }
    }, 100);
  }

  function scheduleBGMNote(st, when) {
    const chordIdx = Math.floor(noteIndex / 4) % st.chords.length;
    const noteInChord = noteIndex % 4;
    const chord = st.chords[chordIdx];
    const t = when - ctx.currentTime;

    // 张力 >= 0.8: Impact 层 (低音加倍 + 音量提升)
    const impact = tensionCur >= 0.8 ? 1.6 : 1;
    // 张力 >= 0.5: Accent 层 (每 2 拍高音点缀)
    const accent = tensionCur >= 0.5;

    // 低音
    const bassNote = chordIdx === 0 ? 0.9 : 0.6;
    tone(chord[0] / 2, st.noteDur * 1.4 * (impact > 1 ? 1.1 : 1), 'sine',
      st.bassGain * bassNote * impact, t, bgmBus);

    // 琶音
    const arpFreq = noteInChord === 3
      ? chord[0] * 2
      : (noteInChord < chord.length ? chord[noteInChord] : chord[0] * 2);
    tone(arpFreq, st.noteDur, st.type, st.arpGain * impact, t + 0.02, bgmBus);

    // 高音点缀 (风格自带 sparkle 或 张力 Accent 层)
    if ((st.sparkle && noteIndex % 8 === 4) || (accent && noteIndex % 4 === 2)) {
      tone(arpFreq * 2, st.noteDur * 0.6, 'sine', st.arpGain * 0.5, t + 0.06, bgmBus);
    }
  }

  function stopBGM() {
    if (bgmTimer) { clearInterval(bgmTimer); bgmTimer = null; }
    stopSong();
  }

  /* ============ 歌曲模式: 播放 music/ 目录下的音频文件 ============ */
  /** 探测歌曲列表 (服务端 /api/music), 有歌且用户未手动选风格 → 自动切到歌曲模式 */
  async function loadSongList() {
    try {
      const res = await fetch('/api/music');
      const data = await res.json();
      songList = (data.songs || []).filter(f => /\.(mp3|ogg|m4a|wav)$/i.test(f));
    } catch (e) { songList = []; }
    if (songList.length > 0 && !bgmStyleUserSet && bgmStyle !== 'song') {
      _lastSynthStyle = bgmStyle;   // 记住合成风格, 歌曲失败时可回退
      _songWanted = true;           // 期望歌曲模式 (若被拦截, 解锁后自动恢复)
      bgmStyle = 'song';
      if (bgmOn && ctx) { stopBGM(); startBGM(); }   // 静默接管背景音乐
    }
  }
  function hasSongs() { return songList.length > 0; }

  function stopSong() {
    if (songAudio) { try { songAudio.pause(); } catch (e) {} }
    songOn = false;
    if (songProgressTimer) { clearInterval(songProgressTimer); songProgressTimer = null; }
  }

  // 歌曲被浏览器拦截/加载失败 → 回退合成 BGM (保证有背景音乐, 不静音), 并标记下次交互重试
  let _lastSynthStyle = 'piano';
  function fallbackToSynthBGM() {
    if (songOn) { try { songAudio.pause(); } catch (e) {} songOn = false; }
    _songRetryPending = true;
    _songWanted = true;   // 仍期望歌曲, 解锁后 retrySongIfNeeded 自动切回
    if (bgmStyle === 'song') bgmStyle = _lastSynthStyle || 'piano';
    stopBGM();
    startBGM();
  }

  /** 播放 songList[i] (可切歌) */
  function playSongAt(i) {
    if (!ctx || !bgmOn || songList.length === 0) return false;
    const idx = ((i % songList.length) + songList.length) % songList.length;
    songIndex = idx;
    const file = songList[idx];
    try {
      if (!songAudio) {
        songAudio = new Audio();
        songAudio.loop = false;               // 播完自动切下一首, 不单曲循环
        songAudio.preload = 'auto';
        // 挂载到 DOM (隐藏): 部分浏览器(Safari/旧内核)对未挂载的 <audio> 播放不稳定
        songAudio.id = 'bgm-audio';
        songAudio.style.display = 'none';
        if (document.body) document.body.appendChild(songAudio);
        if (!songGain) {
          songGain = ctx.createGain();
          songGain.gain.value = (bgmBus ? bgmBus.gain.value : 0.16) * 3;  // mp3 响度补偿
          songGain.connect(bgmBus);
        }
        const src = ctx.createMediaElementSource(songAudio);
        src.connect(songGain);
        // 一首结束 → 自动下一首
        songAudio.addEventListener('ended', () => { nextSong(); });
        // 加载失败 (404/格式不支持) → 回退合成 BGM, 避免"静音"
        songAudio.addEventListener('error', () => {
          if (songOn || _songRetryPending) { console.warn('[Audio] 歌曲加载失败, 回退合成 BGM:', file); fallbackToSynthBGM(); }
        });
      }
      if (songAudio.src !== location.origin + '/music/' + encodeURIComponent(file) &&
          songAudio.src !== '/music/' + encodeURIComponent(file)) {
        songAudio.src = '/music/' + encodeURIComponent(file);
      }
      songAudio.volume = 1;
      songAudio.play().catch(() => {
        // 浏览器自动播放策略拦截 (如首次交互时机外): 记录待重试, 先回退合成 BGM 保证有音乐,
        // 下一次用户交互 (resume 重试) 时自动补播
        console.warn('[Audio] 歌曲播放被浏览器拦截, 回退合成 BGM (下次交互自动重试)');
        fallbackToSynthBGM();
      });
      songOn = true;
      _songRetryPending = false;
      _songWanted = false;   // 歌曲已成功开播, 无需再重试
      // 启动进度轮询 (UI 刷新用)
      if (!songProgressTimer) {
        songProgressTimer = setInterval(() => {
          if (!songAudio) return;
          const info = {
            current: songAudio.currentTime || 0,
            duration: (songAudio.duration && isFinite(songAudio.duration)) ? songAudio.duration : 0,
            song: songList[songIndex] || null,
            index: songIndex,
            total: songList.length
          };
          songListeners.forEach(fn => { try { fn(info); } catch (e) {} });
        }, 300);
      }
      return true;
    } catch (e) {
      console.warn('[Audio] 歌曲播放失败', e);
      fallbackToSynthBGM();
      return false;
    }
  }

  /** 播放当前下标歌曲 (兼容旧调用) */
  function playSong() { return playSongAt(songIndex); }

  /** 下一首 (列表循环) */
  function nextSong() {
    if (songList.length === 0) return false;
    return playSongAt(songIndex + 1);
  }
  /** 上一首 (列表循环) */
  function prevSong() {
    if (songList.length === 0) return false;
    // 播放超过 3 秒: 回到开头; 否则切上一首
    if (songAudio && songAudio.currentTime > 3) {
      seekTo(0);
      return true;
    }
    return playSongAt(songIndex - 1);
  }
  /** 跳转进度 (秒) */
  function seekTo(sec) {
    if (!songAudio) return false;
    const d = (songAudio.duration && isFinite(songAudio.duration)) ? songAudio.duration : 0;
    const t = clamp(Number(sec) || 0, 0, d || Number(sec) || 0);
    try { songAudio.currentTime = t; } catch (e) {}
    return true;
  }
  /** 注册进度回调, 返回取消函数 */
  function onSongProgress(fn) {
    songListeners.push(fn);
    return () => { songListeners = songListeners.filter(f => f !== fn); };
  }
  /** 当前歌曲信息 */
  function getSongInfo() {
    return {
      index: songIndex,
      total: songList.length,
      song: songList[songIndex] || null,
      list: songList.slice()
    };
  }
  function getSongList() { return songList.slice(); }

  /** 切换音乐风格 (含歌曲模式) */
  function setBGMStyle(style) {
    if (style === 'song') {
      if (songList.length === 0) return false;
      bgmStyleUserSet = true;
      _songWanted = true;
      if (bgmStyle !== 'song') _lastSynthStyle = bgmStyle;
    } else if (!BGM_STYLES[style]) {
      return false;
    } else {
      _songWanted = false;   // 用户明确选合成风格, 不再自动切回歌曲
    }
    bgmStyle = style;
    bgmStyleUserSet = true;
    if (bgmOn && ctx) { stopBGM(); startBGM(); }  // 重启调度即换风格
    return true;
  }
  function getBGMStyle() { return bgmStyle; }
  function getBGMInfo() { return BGM_STYLES[bgmStyle] || BGM_STYLES.piano; }

  /** 张力参数驱动 (0~1), 平滑插值 */
  function setTension(v) {
    tension = clamp(Number(v) || 0, 0, 1);
    return tension;
  }
  function getTension() { return tension; }

  // ============ 开关/音量 ============
  function setMuted(m) { muted = m; if (m) stopBGM(); else if (bgmOn) startBGM(); }
  function isMuted() { return muted; }
  function toggleBGM() { bgmOn = !bgmOn; if (bgmOn) { muted = false; startBGM(); } else stopBGM(); return bgmOn; }
  function isBGMOn() { return bgmOn && !muted; }
  function toggleSFX() { sfxOn = !sfxOn; return sfxOn; }
  function isSFXOn() { return sfxOn; }
  function toggleUI() { uiOn = !uiOn; return uiOn; }
  function isUIOn() { return uiOn; }

  function setBGMVolume(v) {
    v = clamp(Number(v) || 0, 0, 1);
    if (bgmBus) bgmBus.gain.value = v;
    if (songGain) songGain.gain.value = v * 3;   // 歌曲跟随音量 (响度补偿一致)
    return v;
  }
  function getBGMVolume() { return bgmBus ? bgmBus.gain.value : 0.16; }
  function setSFXVolume(v) {
    v = clamp(Number(v) || 0, 0, 1);
    if (sfxBus) sfxBus.gain.value = v;
    return v;
  }
  function getSFXVolume() { return sfxBus ? sfxBus.gain.value : 0.7; }
  function setUIVolume(v) {
    v = clamp(Number(v) || 0, 0, 1);
    if (uiBus) uiBus.gain.value = v;
    return v;
  }
  function getUIVolume() { return uiBus ? uiBus.gain.value : 0.35; }

  // ============ 向后兼容别名 (v1 sfx API) ============
  const sfx = {
    click: () => play('sfx:ui:click'),
    deal: () => play('sfx:table:deal'),
    flop: () => play('sfx:table:deal_flop'),
    turn: () => play('sfx:table:deal_turn'),
    river: () => play('sfx:table:deal_river'),
    chip: () => play('sfx:chips:call'),
    fold: () => play('sfx:player:fold'),
    check: () => play('sfx:player:check'),
    raise: () => play('sfx:chips:raise'),
    allin: () => play('sfx:chips:allin'),
    yourTurn: () => play('sfx:ui:your_turn'),
    win: () => play('sfx:result:win'),
    lose: () => play('sfx:result:lose'),
    split: () => play('sfx:result:split'),
    reveal: () => play('sfx:result:reveal'),
    buyIn: () => play('sfx:ui:buyin'),
    notify: () => play('sfx:ui:notify')
  };

  // ============ 对外 API ============
  return {
    init, resume, play, sfx,
    music: { setTension, getTension, setStyle: setBGMStyle, getStyle: getBGMStyle, getInfo: getBGMInfo },
    setMuted, isMuted, toggleBGM, toggleSFX, toggleUI,
    isBGMOn, isSFXOn, isUIOn,
    setBGMStyle, getBGMStyle, getBGMInfo,
    hasSongs, getSongList, getSongInfo,
    playSong, nextSong, prevSong, seekTo, onSongProgress,
    setBGMVolume, getBGMVolume,
    setSFXVolume, getSFXVolume,
    setUIVolume, getUIVolume,
    getActiveVoices: () => activeVoices
  };
})();
// v1 兼容: game.js 用 window.AudioEngine 判断, 必须显式挂载
window.AudioEngine = AudioEngine;
