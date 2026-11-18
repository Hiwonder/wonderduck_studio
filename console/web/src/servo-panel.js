import { createLiveTarget } from './live-target.js';
import { createLiveParameter } from './live-parameter.js';
import { SERVO_STATUS_MAX_AGE_MS, servoStatus } from './state-status.js';
import { createServoLayout } from './servo-layout.js';
import { createSliderTrack } from './slider-track.js';
import defaultServoLayout from './default-servo-layout.json';

const SERVO_DIRECTIONS = {
  10: 'right', 11: 'up', 12: 'down', 13: 'up', 14: 'down',
  20: 'right', 21: 'down', 22: 'up', 23: 'down', 24: 'up',
  30: 'down', 31: 'up', 32: 'left', 33: 'left', 34: 'up',
};
const DIRECTION_LABELS = { up: '上', down: '下', left: '左', right: '右' };

function encoderLimits(joint) {
  if (joint.encoder_limits) return { min: joint.encoder_limits[0], max: joint.encoder_limits[1] };
  return {
    min: Math.max(0, Math.ceil((180 - joint.limits[1]) * 4096 / 360)),
    max: Math.min(4095, Math.floor((180 - joint.limits[0]) * 4096 / 360)),
  };
}

export function createServoPanel({ request, toast, context, select, iconsRefresh, onPose, confirmRelease }) {
  const viewport = document.getElementById('servo-rows');
  const container = document.getElementById('servo-canvas');
  const visibility = document.getElementById('servo-visibility-list');
  const scaleInput = document.getElementById('servo-scale');
  const targets = new Map();
  const rows = new Map();
  const locked = new Set();
  const sliderTrack = createSliderTrack();
  let activeTarget = null, activeOffset = null, offsetWriting = false, operation = 0;
  let offsetRead = false, generation = 0, playbackVisualControls = null, playbackVisualReleaseAt = null;
  let playbackPending = false, lastPlaybackUpdate = null, frameGraceUntil = 0;
  const cardLayout = createServoLayout({ viewport, canvas: container, scaleInput,
    layoutLockButton: document.getElementById('servo-layout-lock'),
    arrangeButton: document.getElementById('servo-arrange'), defaultButton: document.getElementById('servo-default'),
    restoreButton: document.getElementById('servo-restore'),
    defaultLayout: defaultServoLayout,
    onSelect: select, toast, getState: () => ({
      hidden: [...rows].filter(([, row]) => row.element.hidden).map(([id]) => id), locked: [...locked],
    }) });
  for (const id of cardLayout.locked()) locked.add(id);

  function servo(id) { return context().state?.servos?.find(item => item.id === id); }
  function canControl(id, ignoreOperation = false) {
    const { info, state, armed, fresh, connectionError } = context();
    const frameGrace = armed && !connectionError && state?.online && !state?.error && performance.now() < frameGraceUntil;
    return !!info && !info.readonly && !!info.supports_direct_slider && armed && (fresh || frameGrace) && !document.hidden &&
      !state?.parameter_batch_active && !state?.calibration?.active && !playbackPending && state?.action_playback?.state !== 'playing' &&
      !locked.has(id) && (!operation || ignoreOperation) && !!servo(id)?.valid;
  }

  const liveTarget = createLiveTarget({
    context: () => {
      const row = rows.get(activeTarget);
      return { id: activeTarget, ...row?.limits,
        enabled: !!row && canControl(activeTarget) && !offsetWriting && servo(activeTarget)?.torque === 1 };
    },
    send: async data => {
      const result = await request('command', {
        action: 'move_direct', id: data.id, degrees: 180 - data.raw * 360 / 4096, speed: data.speed,
      });
      if (result.sent) document.getElementById('last-command').textContent = `ID ${data.id} · 目标编码器 ${data.raw} 步 · 已发送`;
      return result;
    },
    onError: error => toast(error.message, true),
  });

  const liveOffset = createLiveParameter({
    context: () => {
      const row = rows.get(activeOffset), register = context().info?.registers.find(item => item.address === 31);
      return { id: activeOffset, address: 31, min: register?.minimum, max: register?.maximum,
        enabled: !!row && row.offsetValue !== null && !!register?.writable && canControl(activeOffset) };
    },
    send: async data => {
      const row = rows.get(data.id);
      offsetWriting = true;
      update();
      try {
        const result = await request('command', { action: 'offset_direct', ...data });
        if (result.sent && rows.get(data.id) === row) row.offsetValue = data.value;
        return result;
      }
      finally { offsetWriting = false; update(); }
    },
    onSent: data => {
      const row = rows.get(data.id);
      if (row) row.offsetError = '';
      document.getElementById('last-command').textContent = `ID ${data.id} · 位置校正 ${data.value} · 已发送`;
    },
    onError: error => {
      const row = rows.get(activeOffset);
      if (row) row.offsetError = error.message;
      toast(error.message, true);
      update();
    },
  });

  function cancelOffset() {
    liveOffset.cancel();
    activeOffset = null;
  }

  function cancel() {
    sliderTrack.cancel();
    liveTarget.cancel();
    cancelOffset();
    activeTarget = null;
  }

  function syncInputs(slider, input, value) {
    if (slider.value !== String(value)) slider.value = value;
    paintRange(slider);
    if (document.activeElement !== input && input.value !== slider.value) input.value = slider.value;
  }

  function paintRange(slider) {
    const min = Number(slider.min), max = Number(slider.max), value = Number(slider.value);
    const progress = max > min ? (value - min) * 100 / (max - min) : 0;
    const next = `${Math.max(0, Math.min(100, progress))}%`;
    if (slider.style.getPropertyValue('--range-progress') !== next) slider.style.setProperty('--range-progress', next);
  }

  function bindNumber(input, slider) {
    input.addEventListener('change', () => {
      if (input.disabled) return;
      if (input.value === '' || !input.checkValidity()) {
        input.value = slider.value;
        toast(`请输入 ${slider.min}～${slider.max} 范围内的整数`, true);
        return;
      }
      slider.value = input.value;
      input.value = slider.value;
      slider.dispatchEvent(new Event('input', { bubbles: true }));
    });
    input.addEventListener('keydown', event => {
      if (event.key === 'Enter') { event.preventDefault(); input.blur(); }
      if (event.key === 'Escape') { input.value = slider.value; input.blur(); }
    });
  }

  function makeRow(joint, register) {
    const element = document.createElement('article');
    element.className = 'servo-row';
    element.dataset.id = joint.id;
    element.setAttribute('aria-label', `ID ${joint.id} ${joint.label}`);
    const direction = SERVO_DIRECTIONS[joint.id];
    const directionHint = direction ? `滑杆向右时的方向：${DIRECTION_LABELS[direction]}` : '';
    const directionIcon = direction ? `<span class="servo-direction" title="${directionHint}" aria-hidden="true"><i data-lucide="chevron-${direction}"></i></span>` : '';
    element.innerHTML = '<div class="servo-row-heading"><div><span class="servo-id"></span></div><span class="servo-status"></span><button type="button" class="servo-lock" title="锁定舵机" aria-label="锁定舵机"><i data-lucide="lock-open"></i></button></div>' +
      `<div class="servo-row-controls"><label class="servo-control"><span>位置</span><input type="range" step="1" disabled><input type="number" step="1" disabled>${directionIcon}</label>` +
      '<label class="servo-control"><span>偏差</span><input type="range" step="1" disabled><input type="number" step="1" disabled></label></div>';
    element.querySelector('.servo-id').textContent = `ID ${joint.id}`;
    element.querySelector('.servo-row-heading').title = joint.label;
    const [targetSlider, targetInput, offsetSlider, offsetInput] = element.querySelectorAll('input');
    const limits = encoderLimits(joint);
    targetSlider.min = targetInput.min = limits.min;
    targetSlider.max = targetInput.max = limits.max;
    if (register) {
      offsetSlider.min = offsetInput.min = register.minimum;
      offsetSlider.max = offsetInput.max = register.maximum;
    }
    for (const [input, label] of [[targetSlider, '目标位置滑杆'], [targetInput, '目标位置输入'],
      [offsetSlider, '位置校正滑杆'], [offsetInput, '位置校正输入']]) {
      input.setAttribute('aria-label', `ID ${joint.id} ${joint.label} ${label}`);
      if (directionHint && (input === targetSlider || input === targetInput)) input.setAttribute('aria-description', directionHint);
    }
    const row = { joint, element, limits, targetSlider, targetInput, offsetSlider, offsetInput,
      status: element.querySelector('.servo-status'), offsetValue: null, revision: 0, nextRead: 0, offsetError: '' };
    const lock = element.querySelector('.servo-lock');
    row.lock = lock;
    function renderLock() {
      const isLocked = locked.has(joint.id);
      lock.title = lock.ariaLabel = `${isLocked ? '解锁' : '锁定'} ID ${joint.id}`;
      lock.setAttribute('aria-pressed', String(isLocked));
      lock.innerHTML = `<i data-lucide="${isLocked ? 'lock' : 'lock-open'}"></i>`;
    }
    renderLock();
    lock.addEventListener('click', event => {
      event.stopPropagation();
      if (locked.has(joint.id)) locked.delete(joint.id); else locked.add(joint.id);
      cancel();
      renderLock();
      iconsRefresh();
      cardLayout.persist();
      update();
    });
    cardLayout.attach(joint.id, element);
    bindNumber(targetInput, targetSlider);
    bindNumber(offsetInput, offsetSlider);
    sliderTrack.bind(targetSlider);
    sliderTrack.bind(offsetSlider);
    targetSlider.addEventListener('input', () => {
      if (targetSlider.disabled) return;
      const value = Number(targetSlider.value);
      paintRange(targetSlider);
      targetInput.value = value;
      targets.set(joint.id, value);
      cancelOffset();
      if (activeTarget !== joint.id) liveTarget.cancel();
      activeTarget = joint.id;
      if (servo(joint.id)?.torque === 1) liveTarget.setTarget(value);
      update();
    });
    offsetSlider.addEventListener('input', () => {
      if (offsetSlider.disabled) return;
      const value = Number(offsetSlider.value);
      paintRange(offsetSlider);
      offsetInput.value = value;
      row.revision++;
      liveTarget.cancel();
      if (activeOffset !== joint.id) cancelOffset();
      activeOffset = joint.id;
      if (!liveOffset.setValue(value)) toast('位置校正当前不可写', true);
      update();
    });
    return row;
  }

  function reset(joints) {
    cancel();
    generation++;
    lastPlaybackUpdate = null;
    const hidden = new Set(rows.size ? [...rows].filter(([, row]) => row.element.hidden).map(([id]) => id) : cardLayout.hidden());
    const previousOrder = new Map([...container.children].map((element, index) => [Number(element.dataset.id), index]));
    rows.clear();
    container.replaceChildren();
    visibility.replaceChildren();
    const register = context().info?.registers.find(item => item.address === 31);
    const ordered = [...joints];
    if (previousOrder.size) ordered.sort((a, b) => (previousOrder.get(a.id) ?? Infinity) - (previousOrder.get(b.id) ?? Infinity) || a.id - b.id);
    for (const joint of ordered) {
      const row = makeRow(joint, register);
      rows.set(joint.id, row);
      container.append(row.element);
      const label = document.createElement('label');
      const checkbox = document.createElement('input');
      checkbox.type = 'checkbox'; checkbox.checked = !hidden.has(joint.id);
      row.element.hidden = !checkbox.checked;
      checkbox.addEventListener('change', () => { row.element.hidden = !checkbox.checked; cardLayout.visibilityChanged(); update(); });
      row.visibility = checkbox;
      label.append(checkbox, document.createTextNode(`ID ${joint.id} ${joint.label}`));
      visibility.append(label);
    }
    cardLayout.setItems([...rows].map(([id, row]) => [id, row.element]));
    iconsRefresh();
    update();
  }

  async function readOffset(row) {
    const revision = row.revision, currentGeneration = generation;
    offsetRead = true;
    try {
      const result = await request('command', { action: 'registers', id: row.joint.id });
      const register = result.registers.find(item => item.address === 31);
      if (!register || !Number.isInteger(register.value)) throw new Error('位置校正读取无效');
      if (currentGeneration === generation && revision === row.revision) {
        row.offsetValue = register.value;
        row.offsetError = '';
        syncInputs(row.offsetSlider, row.offsetInput, register.value);
      }
    } catch (error) {
      if (currentGeneration === generation && revision === row.revision) {
        row.offsetError = error.message;
        row.nextRead = performance.now() + 2000;
      }
    } finally {
      offsetRead = false;
      update();
    }
  }

  function update() {
    const { info, state, armed, fresh, elapsed, connectionError, active } = context();
    const playbackActive = state?.action_playback?.state === 'playing';
    const healthy = armed && !connectionError && state?.online && !state?.error;
    const frameGrace = !fresh && healthy && performance.now() < frameGraceUntil;
    const samplingPaused = (playbackActive || playbackPending) && healthy;
    if (samplingPaused && !playbackVisualControls) {
      playbackVisualControls = [document.getElementById('center-all'), document.getElementById('home-all'),
        ...[...rows.values()].flatMap(row => [row.lock, row.visibility, row.targetSlider, row.targetInput,
          row.offsetSlider, row.offsetInput])].filter(control => !control.disabled);
      for (const control of playbackVisualControls) control.classList.add('is-playback-pending');
    }
    if (samplingPaused) playbackVisualReleaseAt = null;
    else if (playbackVisualControls && playbackVisualReleaseAt === null) playbackVisualReleaseAt = performance.now() + 1500;
    if (playbackVisualControls && (!healthy || (!samplingPaused && (fresh || performance.now() >= playbackVisualReleaseAt)))) {
      for (const control of playbackVisualControls) control.classList.remove('is-playback-pending');
      playbackVisualControls = null;
      playbackVisualReleaseAt = null;
    }
    const holdPresentation = samplingPaused || frameGrace || (!!playbackVisualControls && !fresh && healthy);
    const playback = state?.action_playback;
    if (Number.isInteger(playback?.run_id) && playback.run_id > 0 &&
        Number.isInteger(playback.dispatch) && playback.dispatch > 0 && playback.frame_targets) {
      const updateKey = `${playback.run_id}:${playback.dispatch}`;
      if (updateKey !== lastPlaybackUpdate) {
        for (const [key, value] of Object.entries(playback.frame_targets)) {
          const id = Number(key), row = rows.get(id);
          if (row && !locked.has(id) && !row.element.hidden && Number.isInteger(value)) targets.set(id, value);
        }
        lastPlaybackUpdate = updateKey;
      }
    }
    const readyBeforeOffset = !!info && !info.readonly && armed && (fresh || frameGrace) && !document.hidden &&
      !state?.parameter_batch_active && !state?.calibration?.active && !playbackPending && state?.action_playback?.state !== 'playing' &&
      !operation;
    const excluded = id => !rows.has(id) || locked.has(id) || !!rows.get(id)?.element.hidden;
    const allOnline = !!info && info.joints.every(joint => excluded(joint.id) || servo(joint.id)?.valid);
    const hasUnlocked = !!info && info.joints.some(joint => !excluded(joint.id));
    const center = document.getElementById('center-all');
    const centerReady = readyBeforeOffset && allOnline && hasUnlocked;
    center.disabled = !centerReady || offsetWriting;
    center.classList.toggle('is-offset-pending', centerReady && offsetWriting);
    const home = document.getElementById('home-all');
    const homeJoints = info?.joints.filter(joint => !joint.discovered && !excluded(joint.id)) || [];
    const homeReady = readyBeforeOffset && !!info?.supports_home_targets && homeJoints.length > 0 &&
      homeJoints.every(joint => servo(joint.id)?.valid);
    home.disabled = !homeReady || offsetWriting;
    home.classList.toggle('is-offset-pending', homeReady && offsetWriting);
    home.title = info && !info.readonly && !info.supports_home_targets
      ? '重启控制台服务后启用 Home' : '可见且未锁定的舵机回 Home 姿态';
    document.getElementById('release').disabled = !info || !!info.readonly;
    for (const [id, row] of rows) {
      row.lock.disabled = row.visibility.disabled = !!operation || playbackPending || playbackActive;
      const current = servo(id);
      const presentation = holdPresentation && row.lastPresentation
        ? row.lastPresentation : servoStatus(current, state, elapsed, connectionError, SERVO_STATUS_MAX_AGE_MS);
      if (!holdPresentation) row.lastPresentation = presentation;
      if (!targets.has(id) && Number.isInteger(state?.pose_targets?.[id])) targets.set(id, state.pose_targets[id]);
      const target = targets.get(id) ?? (presentation.valid ? current.raw : null);
      if (Number.isInteger(target)) syncInputs(row.targetSlider, row.targetInput, target);
      else if (document.activeElement !== row.targetInput) row.targetInput.value = '';
      row.targetSlider.disabled = row.targetInput.disabled = !canControl(id) || offsetWriting;
      const offsetEnabled = canControl(id) && row.offsetValue !== null && (!offsetWriting || activeOffset === id);
      row.offsetSlider.disabled = row.offsetInput.disabled = !offsetEnabled;
      const available = canControl(id, true);
      for (const input of [row.targetSlider, row.targetInput]) input.classList.toggle('is-write-pending',
        available && (!!operation || offsetWriting));
      for (const input of [row.offsetSlider, row.offsetInput]) input.classList.toggle('is-write-pending',
        available && row.offsetValue !== null && (!!operation || (offsetWriting && activeOffset !== id)));
      const pending = targets.has(id) && current?.torque === 0;
      const status = row.offsetError ? '校正异常' : pending && presentation.valid ? '待运行' : presentation.label;
      if (row.status.textContent !== status) row.status.textContent = status;
      row.status.title = row.offsetError || presentation.title;
      row.status.hidden = row.status.textContent === '开启';
      row.element.title = info && !info.readonly && !info.supports_direct_slider
        ? '重启控制台服务后启用滑杆直接发送' : `${row.joint.label} · ${row.status.textContent} · ${row.status.title}`;
      row.element.classList.toggle('servo-row-error', !presentation.valid || !!row.offsetError);
    }
    if (active && !offsetRead && !offsetWriting && !operation && info && !info.readonly && fresh &&
        !state?.calibration?.active && !playbackPending && state?.action_playback?.state !== 'playing') {
      const next = [...rows.values()].find(row => row.offsetValue === null && servo(row.joint.id)?.valid && performance.now() >= row.nextRead);
      if (next) readOffset(next);
    }
  }

  async function pose(action) {
    if (action !== 'release_all' && operation) return;
    if (action === 'release_all' && !await confirmRelease()) return;
    cancel();
    operation++;
    update();
    try {
      const excluded = id => locked.has(id) || !!rows.get(id)?.element.hidden;
      const joints = context().info.joints;
      const lockedIds = joints.filter(joint => locked.has(joint.id)).map(joint => joint.id);
      let command = { action };
      if (action === 'release_all' && lockedIds.length) {
        if (!context().info.supports_locked_release) throw new Error('请重启控制台服务以启用锁定舵机保护');
        command = { action: 'release_unlocked', locked_ids: lockedIds };
      } else if (action === 'home_all') {
        const { targets: home } = await request('command', { action: 'home_targets' });
        command = { action: 'run_targets', targets: joints.map(joint =>
          [joint.id, excluded(joint.id) || !Number.isInteger(home[joint.id]) ? null : home[joint.id]]) };
      } else if (action === 'center_all' && joints.some(joint => excluded(joint.id))) {
        command = { action: 'run_targets', targets: joints.map(joint => [joint.id, excluded(joint.id) ? null : 2048]) };
      }
      const result = await request('command', command);
      if (!result.verified) throw new Error(`操作未全部确认：${JSON.stringify(result.results)}`);
      if (result.targets) for (const [id, value] of Object.entries(result.targets)) targets.set(Number(id), value);
      const message = action === 'center_all' ? '中位目标已下发并读回' : action === 'home_all'
        ? 'Home 目标已下发并读回' : command.action === 'release_unlocked'
          ? lockedIds.length === joints.length ? '全部舵机均已上锁，未执行卸力' : '未锁定舵机已卸力并读回'
          : '全部卸力已读回';
      document.getElementById('last-command').textContent = message;
      toast(message);
      if (action !== 'release_all') onPose(result.targets);
    } catch (error) { toast(error.message, true); }
    finally { operation--; update(); }
  }

  document.getElementById('center-all').addEventListener('click', () => pose('center_all'));
  document.getElementById('home-all').addEventListener('click', () => pose('home_all'));
  document.getElementById('release').addEventListener('click', () => pose('release_all'));
  function readbackPosition(row, current) {
    if (!Number.isInteger(current?.raw) || current.online === false ||
        (!current.valid && !(current.online && current.error === '编码器位置超出 0..4095'))) return null;
    // HX position uses signed magnitude. Keep an out-of-range reading on its correct side.
    const raw = current.raw >= 0x8000 && current.raw <= 0xffff ? -(current.raw & 0x7fff) : current.raw;
    const min = Math.max(0, row.limits.min), max = Math.min(4095, row.limits.max);
    return Math.max(min, Math.min(max, raw));
  }

  function positions(actual = false) {
    const values = {};
    for (const [id, row] of rows) {
      if (row.element.hidden || locked.has(id)) continue;
      const current = servo(id);
      const value = actual ? readbackPosition(row, current) : targets.get(id) ?? (current?.valid ? current.raw : null);
      if (Number.isInteger(value)) values[id] = value;
    }
    if (!Object.keys(values).length) throw new Error('没有可用的舵机位置');
    return values;
  }

  function setTargets(values) {
    cancel();
    for (const [key, value] of Object.entries(values)) {
      const id = Number(key), row = rows.get(id);
      if (row && !locked.has(id) && !row.element.hidden &&
          (!Number.isInteger(value) || value < row.limits.min || value > row.limits.max)) {
        throw new Error(`ID ${key} 的动作位置超出当前舵机范围`);
      }
    }
    for (const [key, value] of Object.entries(values)) {
      const id = Number(key), row = rows.get(id);
      if (row && !locked.has(id) && !row.element.hidden) targets.set(id, value);
    }
    update();
  }

  async function readOffsets() {
    if (operation || offsetRead || offsetWriting || context().state?.action_playback?.state === 'playing') throw new Error('设备正在执行其他操作');
    cancel(); operation++; update();
    const result = {};
    try {
      for (const [id, row] of rows) {
        if (row.element.hidden) continue;
        const data = await request('command', { action: 'registers', id });
        const value = data.registers.find(item => item.address === 31)?.value;
        if (!Number.isInteger(value)) throw new Error(`ID ${id} 偏差读取无效`);
        row.offsetValue = value; row.offsetError = ''; row.revision++;
        syncInputs(row.offsetSlider, row.offsetInput, value);
        result[id] = value;
      }
      return result;
    } finally { operation--; update(); }
  }

  async function applyOffsets(values) {
    const { info, state, armed, fresh } = context();
    if (!armed || !fresh || info?.readonly || operation || state?.action_playback?.state === 'playing') throw new Error('设备尚未就绪');
    const entries = Object.entries(values);
    const register = info.registers.find(item => item.address === 31);
    if (!entries.length || entries.some(([id, value]) => !rows.has(Number(id)) || !Number.isInteger(value) || value < register.minimum || value > register.maximum)) {
      throw new Error('偏差文件包含未知舵机或无效数值');
    }
    const excludedEntry = entries.find(([id]) => locked.has(Number(id)) || rows.get(Number(id)).element.hidden);
    if (excludedEntry) throw new Error(`ID ${excludedEntry[0]} 已锁定或隐藏，请先启用`);
    cancel(); operation++; update();
    let completed = 0;
    try {
      for (const [key, value] of entries) {
        const id = Number(key), row = rows.get(id);
        try {
          const result = await request('command', { action: 'write_register', id, address: 31, value });
          if (!result.verified) throw new Error('写入未确认');
          row.offsetValue = value; row.offsetError = ''; row.revision++;
          syncInputs(row.offsetSlider, row.offsetInput, value);
          completed++;
        } catch (error) {
          row.offsetValue = null; row.nextRead = 0; row.revision++;
          throw new Error(`ID ${id} 写入失败，已确认 ${completed} 个；后续未写入：${error.message}`);
        }
      }
      return completed;
    } finally { operation--; update(); }
  }

  function offsetValues() {
    const values = {};
    for (const [id, row] of rows) {
      if (row.element.hidden) continue;
      if (!Number.isInteger(row.offsetValue)) throw new Error(`ID ${id} 的偏差尚未读取`);
      values[id] = Number(row.offsetSlider.value);
    }
    if (!Object.keys(values).length) throw new Error('没有可保存的舵机偏差');
    return values;
  }

  function setPlaybackPending(pending) {
    if (playbackPending === pending) return;
    playbackPending = pending;
    update();
  }

  function holdForFrame(until) { frameGraceUntil = until; }

  return { reset, update, cancel, positions, setTargets, setPlaybackPending, holdForFrame, layout: cardLayout.layout, setLayout: cardLayout.setLayout, readOffsets, applyOffsets, offsetValues,
    lockedIds: () => [...rows].filter(([id, row]) => locked.has(id) || row.element.hidden).map(([id]) => id),
    scale: cardLayout.scale };
}
