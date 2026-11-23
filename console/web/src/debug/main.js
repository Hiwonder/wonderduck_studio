import { createIcons, Bot, PowerOff,
  RotateCcw, Download, RefreshCw,
  Save, Pencil, Menu, PanelLeftClose, Crosshair, House, FolderOpen } from 'lucide';
import { createLinkedTarget } from '../linked-target.js';
import { createLiveParameter } from './live-parameter.js';
import { imuFresh, sampleFresh, servoStatus } from './state-status.js';
import './style.css';
import '../font.css';
import '../theme.css';
import './embedded.css';
import '../notifications.css';
import '../interaction.css';
import { createCalibrationControls } from '../calibration-controls.js';
import { createParameterSave } from '../parameter-save.js';
import { createServoControls } from '../servo-controls.js';
import { createReleaseConfirmation } from '../release-confirm.js';
import { friendlyErrorMessage } from '../user-messages.js';
import { setLocalizedAttribute, setLocalizedText, translate } from '../../../../webpadd/web/language.js';

const $ = (id) => document.getElementById(id);
// The parent may show this page before it has a safe maintenance lease.
// In preview mode no arm or register-read request should reach the robot.
const previewOnly = new URLSearchParams(location.search).get('preview') === '1';
const confirmRelease = createReleaseConfirmation();
const client = sessionStorage.getItem('console-client') || crypto.randomUUID?.() || `client-${Date.now()}-${Math.random()}`;
sessionStorage.setItem('console-client', client);
let info, state, selected = 20, parameters = null, parameterId = null, armed = false, busy = false, scanBusy = false;
let token = '', lastGood = 0;
let connectionError = '';
let targetInitialized = false;
let parameterReadBusy = false, parameterReadPending = false, parameterReadTimer = null, parameterRevision = 0;
let servoLayoutRevision = 0;
let parameterAddress = 5, parameterDraft = null, parameterWriteBusy = false;
let parameterView = 'compact';
const parameterScrollPositions = new Map();
let renderedParameterView = parameterView;
let controlPending = false, controlGeneration = 0, nextControlAttempt = 0, controlUpdatedAt = 0, lastControlError = '';
let emergencyReleasePending = false;
let controlRelease = Promise.resolve();
let controlReleasePending = false;
let sessionRefresh = null;
let sliderTrackHold = null, sliderTrackTimer = null;
const sliderTargets = new Map();
const compactParameterAddresses = new Set([
  0x00, 0x01, 0x03, 0x04, 0x05, 0x06, 0x09, 0x0b, 0x0d, 0x10, 0x15, 0x16, 0x17, 0x18, 0x1f,
]);
const fmt = (n, digits = 1) => Number.isFinite(n) ? n.toFixed(digits) : '--';
const iconsRefresh = () => {
  createIcons({ icons: { Bot, PowerOff, RotateCcw, Download, RefreshCw, Save, Pencil, Menu, PanelLeftClose,
    Crosshair, House, FolderOpen }, attrs: { 'stroke-width': 1.8 } });
  document.querySelectorAll('svg[data-lucide]').forEach(icon => icon.removeAttribute('data-lucide'));
};
iconsRefresh();

const sampleElapsed = () => Math.max(0, performance.now() - lastGood);
const stateFresh = () => sampleFresh(state, sampleElapsed(), connectionError);
const canScanServos = () => armed && !document.hidden && !connectionError;
window.addEventListener('message', event => {
  if (event.source === window.parent && event.origin === location.origin && event.data?.type === 'studio-theme'
      && ['light', 'dark'].includes(event.data.theme)) document.documentElement.dataset.theme = event.data.theme;
  if (event.source === window.parent && event.origin === location.origin && event.data?.type === 'studio-emergency-release') {
    emergencyReleasePending = event.data.active === true;
    if (emergencyReleasePending) { controlGeneration++; setArmed(false); }
    else { nextControlAttempt = 0; renewControl(); }
  }
});
const reportEmbeddedSize = () => {
  if (window.parent === window) return;
  const layout = document.querySelector('.inspection-layout');
  window.parent.postMessage({ type: 'studio-debug-size', height: layout.offsetHeight }, location.origin);
};
new ResizeObserver(reportEmbeddedSize).observe(document.querySelector('.inspection-layout'));
window.addEventListener('resize', reportEmbeddedSize);

function setSidebarOpen(open) {
  document.body.classList.toggle('sidebar-open', open);
  $('sidebar-scrim').hidden = !open;
  $('sidebar-toggle').setAttribute('aria-expanded', String(open));
  const label = open ? '收起侧边栏' : '展开侧边栏';
  $('sidebar-toggle').title = label;
  $('sidebar-toggle').setAttribute('aria-label', label);
  $('sidebar-toggle').innerHTML = `<i data-lucide="${open ? 'panel-left-close' : 'menu'}"></i>`;
  iconsRefresh();
}
$('sidebar-toggle').addEventListener('click', () => setSidebarOpen(!document.body.classList.contains('sidebar-open')));
$('sidebar-scrim').addEventListener('click', () => setSidebarOpen(false));
document.addEventListener('keydown', event => { if (event.key === 'Escape') setSidebarOpen(false); });
window.matchMedia('(max-width:720px)').addEventListener('change', () => setSidebarOpen(false));

let forwardedNotice = null, forwardedStatus = null;
function toast(message, error = false) {
  if (message === '工作区已切换，请重新操作') return;
  if (error) message = friendlyErrorMessage(message);
  if (window.parent !== window) {
    forwardedNotice = { type: 'studio-feedback', text: message, error };
    window.parent.postMessage(forwardedNotice, location.origin);
    return;
  }
  $('toast-message').textContent = message;
  $('toast').classList.toggle('error', error);
  $('toast').hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => $('toast').hidden = true, error ? 7000 : 3000);
}
$('toast-close').addEventListener('click', () => { clearTimeout(toast.timer); $('toast').hidden = true; });
let lastEmbeddedCommand = $('last-command').textContent;
new MutationObserver(() => {
  const message = $('last-command').textContent;
  if (window.parent === window || !message || message === lastEmbeddedCommand) return;
  lastEmbeddedCommand = message;
  forwardedStatus = { type: 'studio-feedback', text: message, error: false, routine: true };
  window.parent.postMessage(forwardedStatus, location.origin);
}).observe($('last-command'), { childList: true, characterData: true, subtree: true });
window.addEventListener('message', event => {
  if (event.source !== window.parent || event.origin !== location.origin
      || event.data?.type !== 'studio-workspace' || event.data.page !== 'debug') return;
  if (forwardedStatus) window.parent.postMessage(forwardedStatus, location.origin);
  if (forwardedNotice) window.parent.postMessage(forwardedNotice, location.origin);
  reportEmbeddedSize();
});

async function confirmAction(title, text) {
  $('confirm-title').textContent = title;
  $('confirm-text').textContent = text;
  const dialog = $('confirm');
  dialog.returnValue = '';
  dialog.showModal();
  return new Promise(resolve => dialog.addEventListener('close', () => resolve(dialog.returnValue === 'ok'), { once: true }));
}

const requestHeaders = () => ({ 'Content-Type': 'application/json', 'X-Console-Token': token, 'X-Console-Client': client, 'X-Studio-Workspace': 'debug' });

async function request(path, body) {
  const response = await fetch(`/api/${path}`, {
    method: body ? 'POST' : 'GET',
    headers: requestHeaders(),
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(path === 'camera/offer' ? 14000 : 6500), cache: 'no-store',
  });
  const data = await response.json();
  if (!response.ok) {
    if (response.status === 403 && data.error === '会话无效，请刷新页面' && path !== 'info') {
      await refreshSession();
      throw new Error('服务已重启，控制会话正在恢复');
    }
    throw Object.assign(new Error(data.error || `HTTP ${response.status}`), { status: response.status });
  }
  if (previewOnly && path === 'info') data.readonly = true;
  return data;
}

function refreshSession() {
  if (!sessionRefresh) {
    setArmed(false);
    sessionRefresh = request('info').then(updated => {
      info = updated;
      token = updated.token;
      applyMode();
      makeServoRows();
      selectServo(updated.joints.some(joint => joint.id === selected) ? selected : updated.joints[0].id);
    }).finally(() => { sessionRefresh = null; });
  }
  return sessionRefresh;
}

async function command(action, data = {}) {
  if ((busy || scanBusy || parameterWriteBusy || parameterSave.isRunning() || state?.parameter_batch_active) && action !== 'release_all') throw new Error('上一操作尚未完成');
  const id = data.id ?? selected;
  liveTarget.cancel();
  liveParameter.cancel();
  busy = true;
  updateControls();
  try {
    const result = await request('command', { action, id, ...data });
    if (!['registers', 'read_raw'].includes(action)) {
      const pose = action === 'center_all' ? '中位 2048' : action === 'home_all' ? 'Home' : null;
      const message = result.verified ? (pose ? `${pose} 目标已下发并读回` : '寄存器读回一致') : '部分卸力未确认';
      $('last-command').textContent = `${pose ? `${Object.keys(result.targets).length} 个舵机` : `ID ${id}`} · ${message}`;
      toast(message, !result.verified);
      if (!result.verified) console.warn('部分卸力未确认', result.results);
    }
    return result;
  } finally { busy = false; updateControls(); }
}

function handle(id, fn) {
  $(id).addEventListener('click', async () => { try { await fn(); } catch (e) { toast(e.message, true); } });
}

function setArmed(value) {
  if (!value) { liveTarget.cancel(); liveParameter.cancel(); parameterDraft = null; targetInitialized = false; }
  armed = value;
  updateControls();
}

async function renewControl() {
  if (!info || info.readonly || emergencyReleasePending || document.hidden || controlPending || performance.now() < nextControlAttempt) return;
  if (state && (!state.online || connectionError)) return;
  const generation = controlGeneration;
  controlPending = true;
  try {
    await controlRelease;
    if (generation !== controlGeneration || document.hidden) return;
    const result = await request('arm', { on: true });
    if (generation !== controlGeneration || document.hidden) { releaseControl(); return; }
    controlUpdatedAt = performance.now();
    nextControlAttempt = performance.now() + 10000;
    lastControlError = '';
    setArmed(result.armed);
  } catch (error) {
    if (generation === controlGeneration) {
      setArmed(false);
      nextControlAttempt = performance.now() + 2000;
      if (lastControlError !== error.message) toast(error.message, true);
      lastControlError = error.message;
    }
  } finally { controlPending = false; }
}

function releaseControl() {
  controlGeneration++;
  nextControlAttempt = 0;
  setArmed(false);
  if (!token || info?.readonly) return Promise.resolve();
  const sendRelease = () => fetch('/api/arm', {
    method: 'POST', headers: requestHeaders(), body: JSON.stringify({ on: false }),
    keepalive: true, signal: AbortSignal.timeout(2500),
  });
  // Start the first keepalive request during the exit event, before the page unloads.
  const pending = controlReleasePending ? controlRelease.then(sendRelease) : sendRelease();
  controlReleasePending = true;
  controlRelease = pending.then(() => {}, () => {});
  const currentRelease = controlRelease;
  currentRelease.then(() => { if (currentRelease === controlRelease) controlReleasePending = false; });
  return controlRelease;
}

setInterval(renewControl, 1000);
handle('release', async () => { if (await confirmRelease()) return command('release_all'); });
const servoControls = createServoControls({ request, command, toast,
  cancel: () => { stopSliderTrack(); liveTarget.cancel(); liveParameter.cancel(); },
  setBusy: value => { scanBusy = value; updateControls(); if (!value && parameterReadPending) queueParameterRead(); },
  // Discovery probes can delay the next telemetry snapshot. Every probe still
  // requires an active maintenance session and an armed client on the server.
  active: canScanServos,
  onDiscovery: joint => {
    if (info.joints.some(current => current.id === joint.id)) return;
    info.joints.push(joint); makeServoRows(); renderServos(); updateControls();
  },
  onPose: result => {
    for (const [id, raw] of Object.entries(result.targets)) sliderTargets.set(Number(id), raw);
    syncTarget(); targetInitialized = true; renderServos(); queueParameterRead();
  },
});
const liveTarget = createLinkedTarget({
  context: motionContext,
  isSelected: id => parameterSave.isServoSelected(id),
  send: async data => {
    const result = await request('command', {
      action: 'move_direct', id: data.id, degrees: 180 - data.raw * 360 / 4096, speed: data.speed,
    });
    if (result.sent) $('last-command').textContent = `ID ${data.id} · 目标编码器 ${data.raw} 步 · 已发送`;
    return result;
  },
  onError: error => { targetInitialized = false; toast(error.message, true); },
  onTarget: (id, raw) => sliderTargets.set(id, raw),
});

const liveParameter = createLiveParameter({
  context: () => ({ ...parameterContext(), enabled: parameterAddress === 31 && parameterContext().enabled }),
  send: async data => {
    parameterWriteBusy = true;
    parameterRevision++;
    updateControls();
    try { return await request('command', { action: 'write_register', ...data }); }
    finally { parameterWriteBusy = false; updateControls(); }
  },
  onVerified: data => {
    const r = parameters?.registers.find(r => r.address === data.address);
    if (parameterId === data.id && r) {
      r.value = data.value;
      const cell = document.querySelector(`#parameter-rows tr[data-address="${data.address}"]`)?.children[3];
      if (cell) { cell.textContent = data.value; cell.title = cell.textContent; }
    }
    $('last-command').textContent = `ID ${data.id} · 位置校正 ${data.value} · 已读回`;
  },
  onComplete: () => { parameterDraft = null; queueParameterRead(1200); },
  onError: error => { parameterDraft = null; queueParameterRead(); toast(error.message, true); },
});

function parameterContext() {
  const r = parameters?.registers.find(r => r.address === parameterAddress);
  const current = state?.servos?.find(s => s.id === selected);
  const online = stateFresh();
  return { id: selected, address: parameterAddress, min: r?.minimum, max: r?.maximum,
    enabled: armed && !busy && !scanBusy && !parameterSave.isRunning() && !state?.parameter_batch_active && !document.hidden && online && !!current?.valid && parameterId === selected && !!r?.writable };
}

function encoderLimits(joint) {
  if (joint.encoder_limits) return { min: joint.encoder_limits[0], max: joint.encoder_limits[1] };
  return {
    min: Math.max(0, Math.ceil((180 - joint.limits[1]) * 4096 / 360)),
    max: Math.min(4095, Math.floor((180 - joint.limits[0]) * 4096 / 360)),
  };
}

function motionContext(id = selected) {
  const current = state?.servos?.find(s => s.id === id);
  const joint = info?.joints.find(j => j.id === id);
  const online = stateFresh();
  return { id, actual: current?.raw, ...(joint ? encoderLimits(joint) : {}),
    enabled: armed && !busy && !scanBusy && !parameterSave.isRunning() && !state?.parameter_batch_active && !parameterWriteBusy && !document.hidden && online && !!current?.valid && current.torque === 1 };
}

$('torque').addEventListener('change', async event => {
  const id = selected, on = event.target.checked;
  liveTarget.cancel();
  targetInitialized = false;
  updateControls();
  try {
    if (on && !await confirmAction(`开启 ID ${id} 扭矩`, '将以该舵机当前测量位置作为保持目标。')) return;
    await command('torque', { id, on });
    if (id === selected) queueParameterRead();
  } catch (error) { toast(error.message, true); }
  finally { updateControls(); }
});
document.addEventListener('visibilitychange', () => { if (document.hidden) releaseControl(); else renewControl(); });
window.addEventListener('pagehide', releaseControl);
window.addEventListener('pageshow', renewControl);

function updateControls() {
  const current = state?.servos?.find(s => s.id === selected);
  const operationBusy = busy || scanBusy || parameterSave.isRunning() || !!state?.parameter_batch_active;
  const online = stateFresh();
  const poseEnabled = armed && !operationBusy && !parameterWriteBusy && !document.hidden && online &&
    info?.joints.some(joint => state.servos.some(servo => servo.id === joint.id && servo.valid));
  servoControls.update({ center: poseEnabled,
    home: armed && !operationBusy && !parameterWriteBusy && !document.hidden && online &&
      info?.joints.filter(joint => !joint.discovered).some(joint => state.servos.some(servo => servo.id === joint.id && servo.valid)),
    scan: canScanServos() && !operationBusy && !parameterWriteBusy && !parameterReadBusy });
  $('torque').disabled = !armed || operationBusy || parameterWriteBusy || !online || !current?.valid;
  $('torque').checked = current?.torque === 1;
  $('target-slider').disabled = !liveTarget.enabled();
  if ($('target-slider').disabled) liveTarget.cancel();
  $('parameter-slider').disabled = !parameterContext().enabled || (parameterWriteBusy && parameterAddress !== 31);
  if (sliderTrackHold?.slider.disabled) stopSliderTrack();
  $('target-input').disabled = $('target-slider').disabled;
  $('parameter-input').disabled = $('parameter-slider').disabled;
  if ($('parameter-slider').disabled) liveParameter.cancel();
  $('write-parameter').disabled = !parameterContext().enabled || parameterWriteBusy;
  $('refresh-params').disabled = operationBusy || parameterReadBusy || parameterWriteBusy || !online;
  $('export-params').disabled = !!info?.readonly || !parameters || parameterId !== selected;
  $('release').disabled = !info || !!info.readonly;
  parameterSave.update();
}

function setTarget(value, remember = true) {
  const joint = info?.joints.find(j => j.id === selected);
  if (!joint || !Number.isFinite(value)) return;
  const { min, max } = encoderLimits(joint);
  value = Math.max(min, Math.min(max, Math.round(value)));
  $('target-value').textContent = `${value} 步`;
  $('target-slider').value = value;
  if (remember) sliderTargets.set(selected, value);
  syncSliderInput('target');
  return value;
}
function syncTarget() {
  const value = sliderTargets.has(selected) ? sliderTargets.get(selected) : state?.pose_targets?.[selected];
  const current = state?.servos?.find(servo => servo.id === selected);
  if (info?.readonly) {
    $('target-value').textContent = Number.isInteger(value) ? `${value} 步` : '-- 步';
    $('target-input').value = Number.isInteger(value) ? value : '';
    return;
  }
  setTarget(value ?? current?.raw ?? 2048, value !== null);
  if (value === null) { $('target-value').textContent = '-- 步'; $('target-input').value = ''; }
}
$('target-slider').addEventListener('input', () => {
  const raw = Number($('target-slider').value);
  if (!liveTarget.setTarget(raw)) {
    stopSliderTrack();
    syncTarget();
    $('target-input').value = $('target-slider').value;
    return;
  }
  setTarget(raw);
  renderServos();
});

function stopSliderTrack() {
  clearTimeout(sliderTrackTimer);
  sliderTrackTimer = null;
  const hold = sliderTrackHold;
  sliderTrackHold = null;
  if (hold?.pointerId !== undefined && hold.slider.hasPointerCapture(hold.pointerId)) {
    hold.slider.releasePointerCapture(hold.pointerId);
  }
}

function repeatSliderTrack(delay = 50) {
  const hold = sliderTrackHold;
  if (!hold) return;
  const { slider, direction, id, address } = hold;
  if (slider.disabled || document.hidden || selected !== id || parameterAddress !== address) {
    stopSliderTrack();
    return;
  }
  const value = Number(slider.value);
  const next = Math.max(Number(slider.min), Math.min(Number(slider.max), value + direction));
  if (next === value) { stopSliderTrack(); return; }
  slider.value = next;
  slider.dispatchEvent(new Event('input', { bubbles: true }));
  slider.dispatchEvent(new Event('change', { bubbles: true }));
  if (sliderTrackHold === hold) sliderTrackTimer = setTimeout(repeatSliderTrack, delay);
}

function stepSliderTrack(event) {
  const slider = event.currentTarget;
  if (slider.disabled || (event.button !== undefined && event.button !== 0) || event.pointerType === 'touch') return;
  const pointer = event.touches?.[0] ?? event;
  const min = Number(slider.min), max = Number(slider.max), value = Number(slider.value);
  if (max <= min) return;
  const bounds = slider.getBoundingClientRect(), thumbSize = 16;
  // Native range thumbs travel between the track's inset endpoints.
  const thumbX = bounds.left + thumbSize / 2 + (value - min) / (max - min) * (bounds.width - thumbSize);
  if (Math.abs(pointer.clientX - thumbX) <= thumbSize / 2) return;
  event.preventDefault();
  stopSliderTrack();
  slider.focus({ preventScroll: true });
  sliderTrackHold = { slider, direction: pointer.clientX < thumbX ? -1 : 1,
    id: selected, address: parameterAddress, pointerId: event.pointerId };
  if (event.pointerId !== undefined) slider.setPointerCapture(event.pointerId);
  repeatSliderTrack(350);
}
function syncSliderInput(name) {
  const slider = $(`${name}-slider`), input = $(`${name}-input`);
  input.min = slider.min;
  input.max = slider.max;
  if (document.activeElement !== input) input.value = slider.value;
}

for (const name of ['target', 'parameter']) {
  const input = $(`${name}-input`), slider = $(`${name}-slider`);
  input.addEventListener('change', () => {
    if (input.disabled) return;
    if (!input.checkValidity() || input.value === '') {
      toast(`请输入 ${slider.min}～${slider.max} 范围内的数值`, true);
      input.value = slider.value;
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

for (const id of ['target-slider', 'parameter-slider']) {
  $(id).addEventListener('pointerdown', stepSliderTrack);
  $(id).addEventListener('touchstart', stepSliderTrack, { passive: false });
  $(id).addEventListener('lostpointercapture', stopSliderTrack);
}
for (const type of ['pointerup', 'pointercancel', 'touchend', 'touchcancel', 'blur', 'pagehide']) {
  window.addEventListener(type, stopSliderTrack);
}
document.addEventListener('visibilitychange', () => { if (document.hidden) stopSliderTrack(); });

function selectServo(id) {
  stopSliderTrack();
  liveTarget.cancel();
  liveParameter.cancel();
  parameterDraft = null;
  parameterRevision++;
  selected = id;
  highlightSelectedJoint();
  const joint = info.joints.find(j => j.id === id);
  $('selected-name').textContent = joint.label;
  $('selected-meta').textContent = `ID ${id}`;
  $('parameter-title').textContent = `ID ${id} · 舵机参数`;
  const { min, max } = encoderLimits(joint);
  $('target-slider').min = min;
  $('target-slider').max = max;
  $('target-limits').replaceChildren();
  for (const value of [min, max]) {
    const span = document.createElement('span');
    span.textContent = `${value} 步`;
    $('target-limits').append(span);
  }
  const current = state?.servos.find(s => s.id === id);
  targetInitialized = !!current?.valid;
  syncTarget();
  parameters = null;
  parameterId = null;
  renderParameters();
  updateParameterEditor();
  renderServos();
  updateControls();
  queueParameterRead();
}

function makeServoRows() {
  $('servo-rows').replaceChildren();
  for (const joint of [...info.joints].sort((a, b) => Number(!!a.discovered) - Number(!!b.discovered) || a.id - b.id)) {
    const tr = document.createElement('tr');
    tr.dataset.id = joint.id;
    tr.tabIndex = 0;
    tr.setAttribute('aria-label', `${joint.label} ID ${joint.id}`);
    for (let i = 0; i < 9; i++) tr.append(document.createElement('td'));
    const id = document.createElement('span');
    id.className = 'id-label'; id.textContent = joint.id;
    tr.children[0].append(parameterSave.servoCheckbox(joint.id), id, document.createTextNode(joint.label));
    tr.addEventListener('click', () => selectServo(joint.id));
    tr.addEventListener('keydown', (e) => { if (e.key === 'Enter') selectServo(joint.id); });
    $('servo-rows').append(tr);
  }
}

function renderServos() {
  if (info?.readonly) syncTarget();
  for (const row of $('servo-rows').children) {
    const servo = state?.servos?.find(s => s.id === Number(row.dataset.id));
    const presentation = servoStatus(servo, state, sampleElapsed(), connectionError);
    const { valid } = presentation;
    const held = !presentation.fresh && row.children[2].textContent !== '' && row.children[2].textContent !== '--';
    row.classList.toggle('historical', held);
    const label = ({ stale: '过期', connection: '断连', acquisition: '异常' })[presentation.kind] || presentation.label;
    const readings = presentation.fresh && servo?.online !== false && Number.isFinite(servo?.raw);
    const poseTarget = sliderTargets.has(Number(row.dataset.id)) ? sliderTargets.get(Number(row.dataset.id)) : state?.pose_targets?.[row.dataset.id];
    const values = [Number.isInteger(poseTarget) ? poseTarget : '--',
      readings ? servo.raw : '--', valid ? fmt(servo.degrees) : '--',
      readings ? fmt(servo.speed_rad_s, 3) : '--', readings ? fmt(servo.load_percent) : '--',
      readings ? fmt(servo.voltage) : '--', readings ? fmt(servo.temperature, 0) : '--', label];
    row.classList.toggle('selected', Number(row.dataset.id) === selected);
    row.setAttribute('aria-selected', Number(row.dataset.id) === selected);
    row.dataset.status = presentation.kind;
    row.classList.toggle('offline', presentation.kind === 'offline');
    row.classList.toggle('fault', presentation.kind === 'fault');
    row.classList.toggle('status-error', presentation.kind !== 'normal');
    row.title = presentation.title + (info?.readonly ? '；编码器步数由 robotd 关节角度换算；未发布数据不额外读取' : '') + (held ? '；灰色数值为上次读数' : '');
    for (let i = 0; i < values.length; i++) {
      if (held && i > 0 && i < values.length - 1) continue;
      const cell = row.children[i + 1];
      setLocalizedText(cell, values[i], i === values.length - 1);
      setLocalizedAttribute(cell, 'title', values[i], i === values.length - 1);
    }
    if (servo?.id === selected) {
      if (valid && !targetInitialized) {
        syncTarget();
        targetInitialized = true;
      }
    }
  }
}

function queueParameterRead(delay = 120) {
  clearTimeout(parameterReadTimer);
  parameterReadTimer = setTimeout(readParameters, delay);
}

async function readParameters() {
  clearTimeout(parameterReadTimer);
  if (previewOnly) {
    parameters = null;
    parameterId = null;
    renderParameters('维护未就绪，参数不可用');
    updateParameterEditor();
    return;
  }
  parameterReadPending = true;
  if (parameterReadBusy || busy || scanBusy || parameterWriteBusy) return;
  const id = selected, revision = parameterRevision;
  parameterReadBusy = true;
  parameterReadPending = false;
  updateControls();
  try {
    const result = await request('command', { action: 'registers', id });
    if (id !== selected || revision !== parameterRevision) return;
    parameters = result;
    parameterId = id;
    renderParameters();
    updateParameterEditor();
  } catch (error) {
    if (id === selected && revision === parameterRevision) {
      console.warn('读取舵机参数失败', error);
      renderParameters(friendlyErrorMessage(error.message));
      toast(error.message, true);
    }
  } finally {
    parameterReadBusy = false;
    updateControls();
    if (parameterReadPending) queueParameterRead();
  }
}
handle('refresh-params', readParameters);
for (const button of $('parameter-view').querySelectorAll('button')) {
  button.addEventListener('click', () => {
    parameterView = button.dataset.view;
    for (const option of $('parameter-view').querySelectorAll('button')) {
      option.setAttribute('aria-pressed', String(option === button));
    }
    renderParameters();
  });
}

function renderParameters(error) {
  const rows = $('parameter-rows');
  const scroller = rows.closest('.parameter-table-scroll');
  if (rows.querySelector('tr[data-address]')) {
    parameterScrollPositions.set(renderedParameterView, { top: scroller.scrollTop, left: scroller.scrollLeft });
  }
  if (!parameters) {
    const tr = document.createElement('tr'); const td = document.createElement('td');
    td.colSpan = 6; td.className = 'empty'; td.textContent = error || '读取中'; tr.append(td); rows.replaceChildren(tr); return;
  }
  const content = document.createDocumentFragment();
  for (const r of parameters.registers) {
    if (parameterView === 'compact' && !compactParameterAddresses.has(r.address)) continue;
    const row = document.createElement('tr');
    row.dataset.address = r.address;
    row.classList.toggle('selected', r.address === parameterAddress);
    row.classList.toggle('parameter-draft', parameterSave.draft(r.address) !== undefined);
    for (const value of [`0x${r.address.toString(16).padStart(2, '0')}`, r.name, r.region, parameterSave.value(r) ?? '--', r.unit]) {
      const cell = document.createElement('td'); cell.textContent = value; cell.title = cell.textContent; row.append(cell);
    }
    row.children[0].className = 'mono';
    row.children[0].prepend(parameterSave.parameterCheckbox(r));
    const cell = document.createElement('td');
    if (r.writable) {
      const button = document.createElement('button'); button.className = 'icon'; button.title = `调整${r.name}`;
      button.setAttribute('aria-label', button.title); button.innerHTML = '<i data-lucide="pencil"></i>';
      row.tabIndex = 0; row.classList.add('editable');
      row.onclick = () => {
        stopSliderTrack();
        liveParameter.cancel();
        parameterAddress = r.address;
        parameterDraft = parameterSave.draft(r.address) ?? null;
        renderParameters();
        updateParameterEditor();
        updateControls();
      };
      row.onkeydown = event => { if (event.target === row && ['Enter', ' '].includes(event.key)) { event.preventDefault(); row.click(); } };
      cell.append(button);
    } else { cell.textContent = '只读'; cell.className = 'muted'; }
    row.append(cell); content.append(row);
  }
  rows.replaceChildren(content);
  renderedParameterView = parameterView;
  iconsRefresh(); parameterSave.update();
  const position = parameterScrollPositions.get(parameterView);
  scroller.scrollTop = position?.top ?? 0;
  scroller.scrollLeft = position?.left ?? 0;
}

function updateParameterEditor() {
  const address = parameterAddress;
  const r = parameters?.registers.find(r => r.address === address) || info?.registers.find(r => r.address === address);
  if (!r) return;
  $('parameter-name').textContent = r.name;
  if (info?.readonly) {
    $('parameter-value').textContent = '未发布';
    $('parameter-input').value = '';
    $('parameter-limit').textContent = 'robotd 未发布寄存器配置；只读模式不额外读取硬件';
    return;
  }
  $('parameter-slider').min = r.minimum;
  $('parameter-slider').max = r.maximum;
  $('parameter-slider').setAttribute('aria-label', r.name);
  $('parameter-slider').value = parameterDraft ?? parameterSave.value(r) ?? Math.max(r.minimum, Math.min(r.maximum, 0));
  syncSliderInput('parameter');
  renderParameterValue(r);
  $('write-parameter').hidden = address === 31;
  $('parameter-limit').replaceChildren();
  for (const value of [r.minimum, r.maximum]) {
    const span = document.createElement('span');
    span.textContent = `${value}${r.unit ? ` ${r.unit}` : ''}`;
    $('parameter-limit').append(span);
  }
}

function renderParameterValue(r) {
  syncSliderInput('parameter');
  const value = Number($('parameter-slider').value);
  const choices = {
    6: ['1 Mbps', '500k', '250k', '128k', '115.2k', '76.8k', '57.6k', '38.4k'].map((label, index) => [index, label]),
    8: [[0, '读应答'], [1, '全应答']],
    33: [[0, '位置'], [1, '恒速'], [2, 'PWM']],
    40: [[0, '关闭'], [1, '开启'], [128, '校准']],
    55: [[0, '解锁'], [1, '锁定']],
  }[r.address];
  const label = choices?.find(([number]) => number === value)?.[1];
  $('parameter-value').textContent = label ? `${value} · ${label}` : value;
  $('parameter-slider').setAttribute('aria-valuetext', $('parameter-value').textContent);
}
$('parameter-slider').addEventListener('input', () => {
  if ($('parameter-slider').disabled) return;
  const r = parameters?.registers.find(r => r.address === parameterAddress);
  if (!r) return;
  parameterDraft = Number($('parameter-slider').value);
  parameterSave.edit(r, parameterDraft);
  renderParameterValue(r);
  if (parameterAddress === 31) { liveTarget.cancel(); liveParameter.setValue(parameterDraft); }
});
const parameterSave = createParameterSave({ request, command, toast,
  context: () => ({ id: selected, address: parameterAddress, value: Number($('parameter-slider').value),
    parameterId, registers: parameters?.registers, joints: info?.joints, servos: state?.servos,
    armed, readonly: !!info?.readonly, online: stateFresh(), busy: busy || scanBusy || !!state?.parameter_batch_active, parameterWriteBusy }),
  cancelMotion: () => { stopSliderTrack(); liveTarget.cancel(); liveParameter.cancel(); },
  onServoSelectionChange: () => { renderServos(); updateControls(); },
  loaded: address => { parameterAddress = parameters.registers.find(r => compactParameterAddresses.has(r.address) && parameterSave.draft(r.address) !== undefined)?.address ?? address; parameterDraft = null; renderParameters(); updateParameterEditor(); updateControls(); },
  setBusy: value => { busy = value; parameterRevision++; updateControls(); },
  refresh: async result => {
    parameterDraft = null;
    if (result?.address === 5 && result.id !== result.previous_id) {
      const joints = result.joints ?? (await request('info')).joints;
      servoLayoutRevision++;
      info.joints = joints;
      if (state) state.joints = joints;
      sliderTargets.delete(result.previous_id);
      sliderTargets.delete(result.id);
      makeServoRows();
      selectServo(result.id);
    }
    await readParameters();
  },
});
function download(name, blob) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a'); a.href = url; a.download = name; a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
handle('export-params', () => download(`servo-${parameterId}-${Date.now()}.json`, new Blob([JSON.stringify(parameters, null, 2)], { type: 'application/json' })));

function quaternionAngles(q) {
  const [w, x, y, z] = q;
  return [Math.atan2(2 * (w * x + y * z), 1 - 2 * (x * x + y * y)),
    Math.asin(Math.max(-1, Math.min(1, 2 * (w * y - z * x)))),
    Math.atan2(2 * (w * z + x * y), 1 - 2 * (y * y + z * z))].map(v => v * 180 / Math.PI);
}

function validQuaternion(q) { return Array.isArray(q) && q.length === 4 && q.every(Number.isFinite) && Math.abs(Math.hypot(...q) - 1) < .05; }

function fmtVector(values, digits = 3) {
  return Array.isArray(values) && values.length === 3 && values.every(Number.isFinite)
    ? values.map(value => fmt(value, digits)).join(', ') : '--';
}

function renderImuComparison() {
  const visible = state.imu_source === 'compare';
  $('imu-comparison').hidden = !visible;
  if (!visible) return;
  const sources = state.imu_sources || {};
  for (const [key, label] of [['id200', 'id200'], ['i2c', 'i2c']]) {
    const imu = sources[key] || {};
    const hasValues = stateFresh() && validQuaternion(imu.quaternion_wxyz);
    const angles = hasValues ? quaternionAngles(imu.quaternion_wxyz) : null;
    $(`compare-${label}-rpy`).textContent = angles ? fmtVector(angles, 2) : '--';
    $(`compare-${label}-gyro`).textContent = hasValues ? fmtVector(imu.gyro_rad_s) : '--';
    $(`compare-${label}-gravity`).textContent = hasValues ? fmtVector(imu.gravity) : '--';
    $(`compare-${label}-quaternion`).textContent = hasValues
      ? `[${imu.quaternion_wxyz.map(value => fmt(value, 4)).join(', ')}]` : '--';
    $(`compare-${label}-status`).textContent = imu.valid ? '有效' : (imu.error || '未就绪');
  }
  const delta = state.imu_comparison;
  $('imu-compare-delta').textContent = Number.isFinite(delta?.orientation_delta_deg)
    ? `${delta.valid ? '两路有效数据差值' : '当前解码值差异（至少一路未就绪）'}：重力方向差 ${fmt(delta.gravity_angle_deg, 2)}° · 角速度差 ${fmt(delta.gyro_delta_rad_s, 3)} rad/s · 重力向量差 ${fmt(delta.gravity_delta, 3)} · 完整姿态差（含航向）${fmt(delta.orientation_delta_deg, 2)}° · 读取间隔 ${fmt(delta.read_offset_ms, 2)} ms。六轴融合的两路航向零点独立。`
    : `差值待两路有效 · 主机读取窗口间隔 ${fmt(delta?.read_offset_ms, 2)} ms`;
}

const calibrationControls = createCalibrationControls({ request, confirmAction, toast });

function renderState() {
  if (state.joints.length !== info.joints.length || state.joints.some((joint, index) => joint.id !== info.joints[index].id)) {
    info.joints = state.joints;
    makeServoRows();
  }
  calibrationControls.render(state.calibration, info?.demo, state.imu_source);
  $('imu-source').value = state.imu_source || info.imu_source || 'id200';
  const fresh = stateFresh();
  const valid = imuFresh(state.imu, state, sampleElapsed(), connectionError) && validQuaternion(state.imu.quaternion_wxyz);
  const servoKinds = fresh ? state.servos.map(servo => servoStatus(servo, state, sampleElapsed(), connectionError).kind) : [];
  const faults = servoKinds.includes('fault');
  const communication = servoKinds.includes('communication');
  const timeout = servoKinds.includes('timeout');
  const missing = servoKinds.filter(kind => kind === 'offline').length;
  const invalid = servoKinds.includes('invalid');
  $('connection').textContent = connectionError ? '连接中断' : state.calibration?.active ? '标定中 · 采集暂停' : !state.online ? '采集异常' : !fresh ? '数据过期'
    : faults ? '舵机故障' : communication ? '总线通信异常' : timeout ? '舵机读取超时'
      : missing === info.joints.length ? '舵机未连接' : missing ? '部分舵机未连接'
      : invalid ? '舵机数据异常' : (info.readonly ? 'robotd · 只读' : info.demo ? '演示连接' : '设备在线');
  $('connection').title = connectionError || state.error || '';
  $('status-dot').className = `dot ${fresh && !faults && !communication && !timeout && !missing && !invalid ? 'live' : 'error'}`;
  $('pose-status').textContent = state.calibration?.active ? '标定中'
    : state.imu_source === 'compare' ? (state.imu_comparison?.valid ? '双路有效' : '对比中')
      : valid ? '实时' : 'IMU 无效';
  $('pose-status').title = state.imu_source === 'compare'
    ? [state.imu_sources?.id200?.error, state.imu_sources?.i2c?.error].filter(Boolean).join('；')
    : state.imu?.error || state.error || '';
  const angles = valid ? quaternionAngles(state.imu.quaternion_wxyz) : [null, null, null];
  const heldAngles = !fresh && $('curve-roll').textContent !== '--';
  $('chart').closest('.chart-layout').classList.toggle('historical', heldAngles);
  const tof = state.tof;
  const tofCurrent = !connectionError && tof?.valid && tof.age_ms + sampleElapsed() <= 1500;
  const tofText = String(tofCurrent ? tof.distance_mm : '--');
  if ($('tof-distance').firstChild.nodeValue !== tofText) $('tof-distance').firstChild.nodeValue = tofText;
  $('tof-reading').title = tof?.error || (tof?.valid ? `数据年龄 ${tof.age_ms} ms` : '等待TOF数据');
  for (const [index, id] of ['roll', 'pitch', 'yaw'].entries()) {
    if (!heldAngles) {
      const text = fmt(angles[index]);
      const curve = $(`curve-${id}`);
      const label = valid ? `${text}°` : '--';
      if (curve.textContent !== label) curve.textContent = label;
    }
  }
  $('servo-count').textContent = `${fresh ? state.servos.filter(s => s.valid).length : 0} / ${info.joints.length}`; $('overview-count').textContent = info.joints.length;
  $('bus-rate').textContent = `${state.hz} Hz`;
  $('read-time').textContent = info.readonly ? '复用 robotd' : `${fmt(state.read_ms)} ms`;
  $('failures').textContent = state.failures;
  $('gyro-calibration').textContent = info.readonly ? '跟随 robotd；校准状态未发布' : state.imu_source === 'compare' ? '双路对比'
    : state.imu_source === 'i2c' ? (state.imu?.valid ? 'I2C 模块输出' : 'I2C 无效')
      : state.imu?.gyro_calibrated ? 'MCU 零偏就绪' : 'MCU 未就绪';
  renderImuComparison();
  renderServos();
  updateControls();
}

$('imu-source').addEventListener('change', async event => {
  const desired = event.target.value;
  const previous = state?.imu_source || info?.imu_source || 'id200';
  event.target.disabled = true;
  try {
    const result = await request('command', { action: 'set_imu_source', source: desired });
    if (state) state.imu_source = result.imu_source;
    event.target.value = result.imu_source;
    toast(`IMU 来源已切换：${result.imu_source === 'id200' ? 'ID200' : result.imu_source === 'i2c' ? 'I2C5' : '双路对比'}`);
  } catch (error) {
    event.target.value = previous;
    toast(error.message, true);
  } finally {
    event.target.disabled = !!info?.readonly;
  }
});

async function poll() {
  const started = performance.now();
  const layoutRevision = servoLayoutRevision;
  try {
    state = await request('state');
    if (layoutRevision !== servoLayoutRevision) state.joints = info.joints;
    state.age_ms += performance.now() - started;
    lastGood = performance.now();
    connectionError = '';
    if (armed && !state.armed && started > controlUpdatedAt) { setArmed(false); nextControlAttempt = 0; }
    if (!armed) renewControl();
    renderState();
  } catch (e) {
    connectionError = e.message;
    if (state) renderState();
    $('connection').textContent = '连接中断'; $('status-dot').className = 'dot error';
    $('pose-status').textContent = '数据已停止';
    setArmed(false); nextControlAttempt = 0; updateControls();
  } finally {
    const period = info?.studio ? 1000 / info.hz : 20;
    setTimeout(poll, document.hidden ? 1000 : Math.max(0, period - (performance.now() - started)));
  }
}

setInterval(() => {
  if (state && !stateFresh() && !['数据过期', '采集异常', '连接中断'].map(translate).includes($('connection').textContent)) renderState();
}, 100);

function highlightSelectedJoint() {
  window.parent.postMessage({ type: 'studio-servo-selected', id: selected }, location.origin);
}

function applyMode() {
  if (info.readonly && !$('imu-source').querySelector('[value="robotd"]')) {
    const option = document.createElement('option');
    option.value = 'robotd'; option.textContent = '跟随 robotd（只读）';
    $('imu-source').append(option);
  }
  $('imu-source').value = info.imu_source;
  $('imu-source').disabled = !!info.readonly;
  if (info.readonly) calibrationControls.render({}, false, 'robotd');
  if (info.readonly) sliderTargets.clear();
  $('demo-badge').hidden = !info.demo;
  $('footer-state').textContent = info.readonly ? 'robotd · 只读订阅 · 相机 / TOF 独立采集' : info.demo ? 'DEMO · 模拟设备' : 'HX · UART8 · 1 Mbps';
}

async function init() {
  try {
    info = await request('info'); token = info.token;
    applyMode();
    parameterAddress = info.registers.find(r => r.writable)?.address ?? 5;
    makeServoRows(); selectServo(20); updateParameterEditor(); await renewControl(); poll();
  } catch (e) { $('connection').textContent = '服务不可用'; toast(e.message, true); setTimeout(init, 3000); }
}
init();
