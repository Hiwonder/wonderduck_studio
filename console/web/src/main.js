import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { modelConfigUrl } from './model-resource.js';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { createIcons, Bot, Power, PowerOff, Menu, PanelLeftClose, Crosshair, Play, SlidersHorizontal, LayoutGrid, RotateCcw, Undo2,
  Lock, LockOpen, Plus, Minus, ListPlus, RefreshCw, Download, Trash2, ArrowUp, ArrowDown, ChevronUp, ChevronDown, ChevronLeft, ChevronRight,
  FlipHorizontal2, FolderOpen, Files, Save, Square, House, Activity, Gauge, Gamepad2, Eye, EyeOff, HandHelping, Footprints, UserRoundSearch, Radar, Settings, Wrench, Wifi, Radio, Battery, Languages } from 'lucide';
import { SAMPLE_MAX_AGE_MS, SERVO_STATUS_MAX_AGE_MS, INDEPENDENT_IMU_MAX_AGE_MS, auxImuStatus, deviceFresh, imuFresh, imuTraceContinues, sampleFresh, servoStatus, tofStatus } from './state-status.js';
import './style.css';
import './simple-controls.css';
import './theme.css';
import './workspaces.css';
import './network.css';
import './models.css';
import './font.css';
import './calibration-view.css';
import './notifications.css';
import './interaction.css';
import { createCalibrationControls } from './calibration-controls.js';
import { createCalibrationCharts } from './calibration-charts.js';
import { createDeviceStatus } from './device-status.js';
import { createConnectionStatus, createLowVoltageIndicator, createNotifications, createSidebar, displayVoltage, lowVoltageWarning, renderSidebarCpu, renderSidebarVoltage } from './sidebar.js';
import { createServoPanel } from './servo-panel.js';
import { createServoDebugMode } from './servo-debug-mode.js';
import { createActionEditor } from './action-editor.js';
import { createCameraPreview } from './camera-preview.js';
import { createMediaPreview } from './media-preview.js';
import { createViewerEnvironment } from './viewer-environment.js';
import { createModelPaletteControl } from './model-palette.js';
import { centerTrunkOnPlatform, createFootHeightAligner, positionForPose } from './ground-placement.js';
import { createNetworkControls } from './network.js';
import { createModelControls } from './models.js';
import { createCalibrationView } from './calibration-view.js';
import { createActionReferenceView } from './action-reference-view.js';
import { createJointHighlighter } from './joint-highlights.js';
import { createReleaseConfirmation } from './release-confirm.js';
import { friendlyErrorMessage } from './user-messages.js';
import { getLanguage, onLanguageChange, setLanguage, setLocalizedText, translate } from '../../../webpadd/web/language.js';
import { version as appVersion } from '../package.json';

const $ = (id) => document.getElementById(id);
const setText = (id, value) => {
  setLocalizedText($(id), value);
};
const fontFamily = getComputedStyle(document.documentElement).fontFamily;
const client = sessionStorage.getItem('console-client') || crypto.randomUUID?.() || `client-${Date.now()}-${Math.random()}`;
sessionStorage.setItem('console-client', client);
let info, state, selected = [], armed = false;
let workspace = 'action';
let token = '', lastImuKey = '', lastGood = 0, responseSequence = 0, lastAuxSequence = -1;
let auxValid = false;
let lowVoltageActive = false, lastLowVoltageNotice = -Infinity;
let connectionError = '';
let stateRequestPending = false, stateRequestStarted = 0;
let resourceRequestPending = false, nextResourceRequest = 0;
let previousStateStarted = 0, statePollInterval = 0, stateRequestDuration = 0, stateRenderDuration = 0;
let lastHeadDiagnostic = -Infinity;
let servoDebugMode;
let controlPending = false, controlGeneration = 0, nextControlAttempt = 0, controlUpdatedAt = 0, lastControlError = '';
let controlRelease = Promise.resolve();
let controlReleasePending = false;
let sessionRefresh = null;
const savedHeadSubscriptionRevision = Number(sessionStorage.getItem('head-subscription-revision'));
let headSubscriptionRevision = Number.isSafeInteger(savedHeadSubscriptionRevision) && savedHeadSubscriptionRevision >= 0
  ? savedHeadSubscriptionRevision : 0;
function advanceHeadSubscription() {
  headSubscriptionRevision++;
  sessionStorage.setItem('head-subscription-revision', String(headSubscriptionRevision));
}
const samples = [], auxSamples = [];
const fmt = (n, digits = 1) => Number.isFinite(n) ? n.toFixed(digits) : '--';
const iconsRefresh = () => {
  createIcons({ icons: { Bot, Power, PowerOff, Menu, PanelLeftClose, Crosshair, Play,
    SlidersHorizontal, LayoutGrid, RotateCcw, Undo2, Lock, LockOpen, Plus, Minus, ListPlus, RefreshCw, Download, Trash2, ArrowUp, ArrowDown, ChevronUp, ChevronDown, ChevronLeft, ChevronRight,
    FlipHorizontal2, FolderOpen, Files, Save, Square, House, Activity, Gauge, Gamepad2, Eye, EyeOff, HandHelping, Footprints, UserRoundSearch, Radar, Settings, Wrench, Wifi, Radio, Battery, Languages }, attrs: { 'stroke-width': 1.8 } });
  // Lucide retains this attribute on rendered SVGs and would otherwise replace them again.
  document.querySelectorAll('svg[data-lucide]').forEach(icon => icon.removeAttribute('data-lucide'));
};
iconsRefresh();
$('app-version').textContent = `v${appVersion}`;

const sampleElapsed = () => Math.max(0, performance.now() - lastGood);
const stateFresh = () => sampleFresh(state, sampleElapsed(), connectionError);
const liveServoFresh = servo => deviceFresh(servo, state, sampleElapsed(), connectionError,
  Number.isFinite(state?.device_report_age_ms) ? SERVO_STATUS_MAX_AGE_MS : SAMPLE_MAX_AGE_MS);

const setConnectionStatus = createConnectionStatus($);
const setSidebarOpen = createSidebar($, iconsRefresh);
const toast = createNotifications($);
const updateLowVoltage = createLowVoltageIndicator();
const confirmRelease = createReleaseConfirmation();

async function confirmAction(title, text) {
  $('confirm-title').textContent = title;
  $('confirm-text').textContent = text;
  const dialog = $('confirm');
  dialog.returnValue = '';
  dialog.showModal();
  return new Promise(resolve => dialog.addEventListener('close', () => resolve(dialog.returnValue === 'ok'), { once: true }));
}

const requestHeaders = () => ({ 'Content-Type': 'application/json', 'X-Console-Token': token, 'X-Console-Client': client,
  'X-Studio-Workspace': workspace,
  'X-Head-Subscription-Revision': String(headSubscriptionRevision),
  ...(workspace === 'calibration' ? { 'X-Calibration-Source': calibrationControls.source() } : {}) });
let cameraPreview;
function updateCameraPreview(page = workspace) {
  const available = page === 'status';
  $('camera-enabled').closest('label').hidden = !available;
  const enabled = available && $('camera-enabled').checked;
  $('camera-preview').hidden = !enabled;
  if (!cameraPreview) return;
  if (enabled && info) cameraPreview.start(); else cameraPreview.stop();
}
$('camera-enabled').addEventListener('change', () => updateCameraPreview());

async function request(path, body, timeoutMs = null) {
  const headers = requestHeaders();
  if (path === 'state' && document.hidden && workspace === 'status') headers['X-Studio-Workspace'] = '';
  const response = await fetch(`/api/${path}`, {
    method: body ? 'POST' : 'GET',
    headers,
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(timeoutMs ?? (path === 'workspace' && body?.rest_before ? 150000 : path === 'workspace' || path === 'emergency-release' || body?.action === 'servo_debug' || path === 'control-actions' && body?.operation !== 'list' ? 60000 : path.startsWith('models/online') && body ? 30000 : path === 'network/scan' ? 20000 : path === 'camera/offer' ? 14000 : 6500)), cache: 'no-store',
  });
  const responseStarted = performance.now();
  const data = await response.json();
  if (!response.ok) {
    if (response.status === 403 && data.error === '会话无效，请刷新页面' && path !== 'info') {
      await refreshSession();
      throw new Error('服务已重启，控制会话正在恢复');
    }
    throw Object.assign(new Error(data.error || `HTTP ${response.status}`), { status: response.status });
  }
  if (path === 'state') {
    // The server computes each age after acquiring its snapshot; request wait time is not sample age.
    const readTime = performance.now() - responseStarted;
    if (Number.isFinite(data.age_ms)) data.age_ms += readTime;
    if (Number.isFinite(data.device_report_age_ms)) data.device_report_age_ms += readTime;
    for (const device of [...(data.servos || []), ...(data.control_servos || []), data.imu]) {
      if (Number.isFinite(device?.age_ms)) device.age_ms += readTime;
      if (Number.isFinite(device?.observation_age_ms)) device.observation_age_ms += readTime;
    }
    if (Number.isFinite(data.aux_imu?.age_ms)) data.aux_imu.age_ms += readTime;
    if (Number.isFinite(data.aux_imu?.sample?.age_us)) data.aux_imu.sample.age_us += readTime * 1000;
    if (Number.isFinite(data.imu?.raw_sample?.age_us)) data.imu.raw_sample.age_us += readTime * 1000;
    for (const calibration of [data.calibration, data.head_calibration]) {
      if (Number.isFinite(calibration?.sample_age_ms)) calibration.sample_age_ms += readTime;
    }
  }
  return data;
}

function refreshSession() {
  if (!sessionRefresh) {
    setArmed(false);
    sessionRefresh = request('info').then(updated => {
      info = updated;
      token = updated.token;
      applyMode();
      servoPanel.reset(updated.joints);
      actionEditor.render();
    }).finally(() => { sessionRefresh = null; });
  }
  return sessionRefresh;
}

function handle(id, fn) {
  $(id).addEventListener('click', async () => { try { await fn(); } catch (error) { toast(error.message, true); } });
}

function updateControls() { servoPanel.update(); actionEditor.update(); servoDebugMode?.update(); }

function setArmed(value) {
  if (!value) servoPanel.cancel();
  armed = value;
  updateControls();
}

async function renewControl() {
  if (!info || info.readonly || sidebarReleaseBusy || (info.studio && (workspace !== 'action' || !document.body.dataset.studioReady)) || document.hidden || workspaceRestoreInFlight || controlPending || performance.now() < nextControlAttempt) return;
  const playbackSamplingPaused = state?.action_playback?.state === 'playing' &&
    state.online && !state.error && !connectionError;
  if (state && !stateFresh() && !playbackSamplingPaused) return;
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
  const pending = controlReleasePending ? controlRelease.then(sendRelease) : sendRelease();
  controlReleasePending = true;
  controlRelease = pending.then(() => {}, () => {});
  const currentRelease = controlRelease;
  currentRelease.then(() => { if (currentRelease === controlRelease) controlReleasePending = false; });
  return controlRelease;
}

const servoPanel = createServoPanel({
  request, toast, iconsRefresh, confirmRelease,
  context: () => ({ info, state, armed, fresh: stateFresh(), elapsed: sampleElapsed(), connectionError,
    active: !info?.studio || (workspace === 'action' && !!document.body.dataset.studioReady) }),
  select: ids => { selected = ids; highlightSelectedJoints(); },
  onPose: alignPoseToPlatform,
});
const actionEditor = createActionEditor({ request, toast, confirmAction, iconsRefresh, servoPanel,
  context: () => ({ info, state, armed, fresh: stateFresh(), connectionError }) });
setInterval(renewControl, 1000);
document.addEventListener('visibilitychange', () => {
  if (info?.studio && token && (workspace === 'status' || !document.hidden && shouldResumeWorkspace())) {
    advanceHeadSubscription();
    if (document.hidden && workspace === 'status') request('state').catch(error => console.debug('设备状态采集切换失败', error.message));
  }
  if (document.hidden) releaseControl();
  else if (info?.studio && shouldResumeWorkspace()) restoreWorkspaceOnVisible();
  else renewControl();
});
window.addEventListener('pagehide', releaseControl);
window.addEventListener('pageshow', () => {
  if (info?.studio && shouldResumeWorkspace()) {
    advanceHeadSubscription();
    restoreWorkspaceOnVisible();
  } else renewControl();
});

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
    setText(`compare-${label}-rpy`, angles ? fmtVector(angles, 2) : '--');
    setText(`compare-${label}-gyro`, hasValues ? fmtVector(imu.gyro_rad_s) : '--');
    setText(`compare-${label}-gravity`, hasValues ? fmtVector(imu.gravity) : '--');
    setText(`compare-${label}-quaternion`, hasValues
      ? `[${imu.quaternion_wxyz.map(value => fmt(value, 4)).join(', ')}]` : '--');
    setText(`compare-${label}-status`, imu.valid ? '有效' : (imu.error || '未就绪'));
  }
  const delta = state.imu_comparison;
  setText('imu-compare-delta', Number.isFinite(delta?.orientation_delta_deg)
    ? `${delta.valid ? '两路有效数据差值' : '当前解码值差异（至少一路未就绪）'}：重力方向差 ${fmt(delta.gravity_angle_deg, 2)}° · 角速度差 ${fmt(delta.gyro_delta_rad_s, 3)} rad/s · 重力向量差 ${fmt(delta.gravity_delta, 3)} · 完整姿态差（含航向）${fmt(delta.orientation_delta_deg, 2)}° · 读取间隔 ${fmt(delta.read_offset_ms, 2)} ms。六轴融合的两路航向零点独立。`
    : `差值待两路有效 · 主机读取窗口间隔 ${fmt(delta?.read_offset_ms, 2)} ms`);
}

const calibrationControls = createCalibrationControls({ request, confirmAction, toast });
const calibrationCharts = createCalibrationCharts({ request, context: () => ({ info, connectionError, elapsed: sampleElapsed() }),
  onStatus: (message, error) => {
    const status = $('calibration-stream-status');
    setLocalizedText(status, message);
    status.hidden = !message;
    status.classList.toggle('error', error);
  },
});
document.addEventListener('calibration-source-change', event => {
  calibrationCharts.setSource(event.detail);
  advanceHeadSubscription();
  if (info?.studio && workspace === 'calibration' && token) {
    request('state').catch(error => console.debug('头部 IMU 采集切换失败', error.message));
  }
});
const deviceStatus = createDeviceStatus({ toast });
const networkControls = createNetworkControls({ request, confirmAction, iconsRefresh, toast });
const modelControls = createModelControls({ request, requestHeaders, refreshSession, confirmAction, toast,
  supportsUpdates: () => !!info?.supports_model_update_resume,
  supportsOnline: () => !!info?.supports_model_update_resume && !!info?.supports_online_models
    && !!info?.supports_online_model_rest && !!info?.supports_model_version_gate });
document.body.dataset.workspace = workspace;
const restrictedPages = new Set(['target', 'pickup', 'line', 'person', 'maze']);
const controlPages = new Set(['control', ...restrictedPages, 'system']);
const maintenancePages = new Set(['action', 'debug', 'calibration']);
const restBeforeWorkspace = new Set(['status', 'action', 'debug', 'calibration']);
const resumePages = new Set(['status', 'action', 'debug', ...restrictedPages]);
// Active calibration owns a separate session. Only re-enter calibration here
// when it was opened as a read-only observation after an unconfirmed release.
const shouldResumeWorkspace = () => resumePages.has(workspace) || (workspace === 'calibration' && info?.readonly);
let switchingWorkspace = false;
let pendingWorkspaceResume = false, workspaceRestoreInFlight = false;
let workspaceRetryRequired = false;
let statusReleaseUnconfirmed = false;
let queuedWorkspace = null, workspaceQueueTimer = null;

function restoreWorkspaceOnVisible() {
  if (!info?.studio || document.hidden || !token || workspaceRetryRequired || !shouldResumeWorkspace()) return;
  if (switchingWorkspace || workspaceRestoreInFlight) { pendingWorkspaceResume = true; return; }
  const target = workspace, revision = headSubscriptionRevision;
  const frame = target === 'debug' ? $('debug-frame') : controlPages.has(target) ? $('control-workspace') : null;
  let restored = false;
  workspaceRestoreInFlight = true;
  delete document.body.dataset.studioReady;
  if (frame) frame.inert = true;
  if (target === 'debug' && frame) frame.src = 'about:blank';
  setArmed(false);
  request('workspace', { workspace: target }).then(async result => {
    if (document.hidden || switchingWorkspace || workspace !== target || headSubscriptionRevision !== revision) return;
    if (target === 'status' && result?.ready !== true) throw new Error(result?.error || '设备状态采集尚未就绪');
    if (maintenancePages.has(target) && result?.maintenance !== true
        && !(result?.readonly === true && result?.release_unconfirmed === true)) throw new Error('维护工作区尚未就绪');
    if (result?.release_unconfirmed === true && !info?.readonly) {
      info = await request('info');
      token = info.token;
    }
    if (target === 'debug' && frame) {
      await loadWorkspaceFrame(frame, result?.readonly ? '/debug.html?preview=1' : '/debug.html');
      if (document.hidden || switchingWorkspace || workspace !== target || headSubscriptionRevision !== revision) {
        frame.src = 'about:blank';
        return;
      }
    }
    restored = true;
    document.body.dataset.studioReady = 'true';
    statusReleaseUnconfirmed = result?.release_unconfirmed === true;
    const warning = statusReleaseUnconfirmed
      ? `${friendlyErrorMessage(result.warning || '卸力未确认')} 当前页面仅可查看。` : '';
    previewWorkspace(target, warning, true, !!warning);
    if (frame) frame.inert = false;
    if (target === 'debug') notifyFrames('studio-workspace', { page: target });
    updateControls();
    if (target === 'status') request('state').catch(error => console.debug('设备状态采集恢复失败', error.message));
  }).catch(error => {
    if (!document.hidden && !switchingWorkspace && workspace === target && headSubscriptionRevision === revision) {
      delete document.body.dataset.studioReady;
      if (frame) frame.inert = true;
      updateControls();
      toast(`恢复当前工作区失败：${error.message}`, true);
    }
  }).finally(() => {
    workspaceRestoreInFlight = false;
    if (pendingWorkspaceResume && !switchingWorkspace) {
      pendingWorkspaceResume = false;
      restoreWorkspaceOnVisible();
    } else if (restored && !document.hidden && workspace === 'action') renewControl();
  });
}
let sidebarTransitionPending = false;
let sidebarTransitionCompleted = 0;
const waitingForFirstSample = value => value?.online === false && value.sequence == null
  && !value.error && !value.calibration?.active;
let leaveRequestId = 0;
let controlActionActive = false, controlActionStarting = false, controlActionPollBusy = false;
let controlActionTimer = null;
let controlActionGeneration = 0, controlActionRunId = null, controlActionPageHidden = false;
let controlActionStartSent = false, controlActionSettled = Promise.resolve();
servoDebugMode = createServoDebugMode({ request, toast, confirmAction,
  context: () => ({ info, state, armed, workspace, switchingWorkspace,
    ready: !info?.studio || !!document.body.dataset.studioReady }) });
const servoToolbar = document.querySelector('.servo-section .section-bar');
const actionHeading = document.querySelector('.action-heading');
const actionAlignment = new ResizeObserver(() => $('action-editor').style.setProperty('--action-top-offset',
  `${Math.max(0, servoToolbar.offsetHeight - actionHeading.offsetHeight)}px`));
actionAlignment.observe(servoToolbar);
actionAlignment.observe(actionHeading);

function leaveControlWorkspace() {
  const frame = $('control-workspace');
  if (!controlFrameActive || !frame.contentWindow || !frame.src || frame.src === 'about:blank') return Promise.resolve();
  controlFrameActive = false;
  const origin = new URL(frame.src).origin;
  const requestId = ++leaveRequestId;
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => finish(new Error('操控页面退出超时，请重试')), 12000);
    function receive(event) {
      if (event.source !== frame.contentWindow || event.origin !== origin
          || event.data?.type !== 'studio-leave-result' || event.data.requestId !== requestId) return;
      finish(event.data.accepted ? null : new Error(event.data.reason || '操控页面退出失败'));
    }
    function finish(error) {
      clearTimeout(timeout);
      window.removeEventListener('message', receive);
      if (error) reject(error); else resolve();
    }
    window.addEventListener('message', receive);
    frame.contentWindow.postMessage({ type: 'studio-leave', requestId }, origin);
  });
}

function notifyFrames(type, data = {}) {
  const control = $('control-workspace');
  if (control.contentWindow && control.src && control.src !== 'about:blank') {
    const message = { type, ...data };
    if (type === 'studio-workspace') message.enabled = document.body.dataset.studioReady === 'true';
    control.contentWindow.postMessage(message, new URL(control.src).origin);
  }
  const debug = $('debug-frame');
  if (debug.contentWindow && debug.src && debug.src !== 'about:blank') {
    debug.contentWindow.postMessage({ type, ...data }, location.origin);
  }
}

function updateLanguageToggle(language) {
  const button = $('language-toggle');
  const target = language === 'en' ? '中文' : 'English';
  button.querySelector('span').textContent = target;
  button.title = language === 'en' ? '切换到中文' : 'Switch to English';
  button.setAttribute('aria-label', button.title);
}
onLanguageChange(language => {
  updateLanguageToggle(language);
  notifyFrames('studio-language', { language });
});
$('language-toggle').addEventListener('click', () => setLanguage(getLanguage() === 'en' ? 'zh' : 'en'));
updateLanguageToggle(getLanguage());

const sidebarDebugMode = $('sidebar-debug-mode');
sidebarDebugMode.checked = false;
function syncDebugMode() {
  notifyFrames('studio-debug-mode', { enabled: sidebarDebugMode.checked });
}
sidebarDebugMode.addEventListener('change', syncDebugMode);

function notifyControlAction(result) {
  const frame = $('control-workspace');
  if (frame.contentWindow && frame.src && frame.src !== 'about:blank') {
    frame.contentWindow.postMessage({ type: 'studio-action-state', result }, new URL(frame.src).origin);
  }
}

function finishControlAction(result, resume = true) {
  controlActionActive = false;
  clearInterval(controlActionTimer);
  controlActionTimer = null;
  notifyControlAction(result);
  if (resume && workspace === 'control') notifyFrames('studio-workspace', { page: workspace });
}

async function stopControlAction(resume = true) {
  const result = await request('control-actions', { operation: 'stop', run_id: controlActionRunId });
  if (!result.active) finishControlAction(result, resume);
  return result;
}

function pollControlAction() {
  if (!controlActionActive || controlActionPollBusy || switchingWorkspace) return;
  controlActionPollBusy = true;
  request('control-actions', { operation: 'status', run_id: controlActionRunId }).then(result => {
    if (!controlActionActive) return;
    if (result.active) notifyControlAction(result);
    else finishControlAction(result);
  }).catch(error => toast(`动作状态读取失败：${error.message}`, true))
    .finally(() => { controlActionPollBusy = false; });
}

async function networkAnnouncementSetting(event) {
  const { requestId, enabled } = event.data;
  if (!Number.isSafeInteger(requestId)) return;
  const reply = data => event.source.postMessage({ type: 'studio-network-announcement-result', requestId, ...data }, event.origin);
  try {
    if (workspace !== 'system') throw new Error('请先打开系统设置');
    if (enabled !== undefined && typeof enabled !== 'boolean') throw new Error('设置无效');
    const result = await request('network-announcement', enabled === undefined ? undefined : { enabled });
    reply({ enabled: result.enabled });
  } catch (error) {
    reply({ error: error.message });
  }
}

let softwareUpdateBusy = false;
const updateStages = {
  prepare: '正在验证发布签名与设备版本',
  download: '正在下载运行包',
  verify: '正在校验运行包',
  checkpoint: '正在保存更新前的软件',
  fetch: '正在获取发布源码',
  install: '正在安装软件',
  restart: '正在重启并检查服务',
  rollback: '正在恢复更新前的软件',
  done: '软件更新完成',
};
const updateDialog = $('software-update-progress');
updateDialog.addEventListener('cancel', event => {
  if ($('software-update-close').disabled) event.preventDefault();
});

function showUpdateStatus(job) {
  const progress = $('software-update-download');
  progress.hidden = job.phase !== 'download' || !Number.isFinite(job.progress);
  if (!progress.hidden) progress.value = job.progress;
  const stage = $('software-update-stage');
  const error = $('software-update-error');
  error.hidden = job.phase !== 'failed';
  if (job.phase === 'failed') {
    stage.textContent = job.rollback === 'done' ? '更新失败，已恢复更新前的软件'
      : job.rollback === 'failed' ? '更新失败，自动恢复未完成'
      : job.rollback === 'unneeded' ? '更新失败，设备仍运行原版本' : '无法确认更新结果';
    error.textContent = [job.error, job.rollback_error].filter(Boolean).join(' / ');
  } else {
    stage.textContent = updateStages[job.phase] || '正在准备软件更新';
  }
}

async function checkSoftwareUpdate() {
  if (workspace !== 'system' || switchingWorkspace || softwareUpdateBusy || !info?.supports_software_update) return;
  const language = getLanguage();
  softwareUpdateBusy = true;
  notifyFrames('studio-software-update-busy', { busy: true });
  try {
    toast('正在检查软件更新', false, { routine: true });
    const { version } = await request('software-update', { action: 'check', language }, 50000);
    if (!version) {
      toast('当前已是最新版本');
      return;
    }
    if (workspace !== 'system' || switchingWorkspace) return;
    if (!await confirmAction('软件更新', '发现新版本 ' + version + '，是否更新？')) return;
    if (workspace !== 'system' || switchingWorkspace) return;
    showUpdateStatus({ phase: 'queued' });
    $('software-update-close').disabled = true;
    updateDialog.showModal();
    const { job_id: jobId } = await request('software-update', { action: 'install', language, version }, 150000);
    const deadline = performance.now() + 900000;
    let inactive = 0;
    while (performance.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 1000));
      let status;
      try { status = await request('software-update', undefined, 4000); }
      catch (_) { continue; }
      const job = status.job?.job_id === jobId ? status.job : null;
      if (job) {
        showUpdateStatus(job);
        if (job.phase === 'failed') return;
        if (job.phase === 'done' && status.current === version) {
          await new Promise(resolve => setTimeout(resolve, 1200));
          location.reload();
          return;
        }
      }
      inactive = status.active ? 0 : inactive + 1;
      if (inactive >= 3) throw new Error('更新未完成，请检查设备日志');
    }
    throw new Error('等待更新完成超时，请检查设备');
  } catch (error) {
    if (updateDialog.open) showUpdateStatus({ phase: 'failed', error: error.message, rollback: 'unknown' });
    else toast('软件更新失败：' + error.message, true);
  } finally {
    $('software-update-close').disabled = false;
    softwareUpdateBusy = false;
    notifyFrames('studio-software-update-busy', { busy: false });
  }
}

async function controlAction(event) {
  const { operation, requestId, name } = event.data;
  const reply = data => event.source.postMessage({ type: 'studio-action-result', requestId, ...data }, event.origin);
  try {
    if (!Number.isSafeInteger(requestId) || workspace !== 'control' || switchingWorkspace || controlActionPageHidden) {
      throw new Error('请先打开运动控制');
    }
    let result;
    if (operation === 'list') {
      result = await request('control-actions', { operation });
    } else if (operation === 'stop') {
      result = await stopControlAction();
    } else if (operation === 'start') {
      if (controlActionStarting || controlActionActive) throw new Error('动作正在执行');
      controlActionStarting = true;
      const generation = ++controlActionGeneration;
      controlActionRunId = crypto.randomUUID?.() || `${client}-${Date.now()}-${Math.random()}`;
      let settleStart;
      controlActionSettled = new Promise(resolve => { settleStart = resolve; });
      let suspended = false, leaveAttempted = false;
      try {
        leaveAttempted = true;
        await leaveControlWorkspace();
        suspended = true;
        if (generation !== controlActionGeneration) throw new Error('动作请求已取消');
        controlActionStartSent = true;
        result = await request('control-actions', { operation, name, run_id: controlActionRunId });
        if (generation !== controlActionGeneration) {
          await stopControlAction(false);
          throw new Error('动作请求已取消');
        }
        controlActionActive = result.active;
        if (controlActionActive) controlActionTimer = setInterval(pollControlAction, 1000);
        else finishControlAction(result);
      } catch (error) {
        if (suspended && !error.status) {
          try { await stopControlAction(false); }
          catch (stopError) {
            controlActionActive = true;
            controlActionTimer = setInterval(pollControlAction, 1000);
            throw new Error(`动作启动结果未知：${error.message}；停止确认失败：${stopError.message}`);
          }
        }
        if (leaveAttempted && generation === controlActionGeneration && workspace === 'control') {
          notifyFrames('studio-workspace', { page: workspace });
        }
        throw error;
      } finally {
        controlActionStarting = false;
        controlActionStartSent = false;
        settleStart();
      }
    } else {
      throw new Error('未知动作库操作');
    }
    reply({ result });
  } catch (error) {
    if (error.message === '动作请求已取消') reply({ result: { state: 'stopped', active: false } });
    else reply({ error: error.message, active: controlActionActive });
  }
}

let sidebarReleaseBusy = false;
let sidebarShutdownBusy = false;
let sidebarRestartBusy = false;
function updateSidebarRestart() {
  const button = $('sidebar-restart');
  button.hidden = !info?.supports_service_restart;
  button.disabled = sidebarRestartBusy || !info?.supports_service_restart;
}

$('sidebar-restart').addEventListener('click', async () => {
  if (sidebarRestartBusy || !info?.supports_service_restart) return;
  sidebarRestartBusy = true;
  updateSidebarRestart();
  try {
    if (!await confirmAction('重启服务', '重启期间操控会短暂中断，请扶稳机器。确定要重启服务吗？')) return;
    if (!info?.supports_service_restart) return;
    const previousToken = token;
    await request('service/restart', {}, 20000);
    toast('服务正在重启，恢复后页面将自动刷新');
    const deadline = performance.now() + 60000;
    while (performance.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 1000));
      try {
        const response = await fetch('/api/info', { cache: 'no-store', signal: AbortSignal.timeout(2500) });
        if (response.ok) {
          const refreshed = await response.json();
          if (typeof refreshed.token === 'string' && refreshed.token && refreshed.token !== previousToken) {
            location.reload();
            return;
          }
        }
      } catch (_) { /* The service is restarting. */ }
    }
    throw new Error('未检测到服务恢复，请检查设备后刷新页面');
  } catch (error) {
    toast(`重启服务失败：${error.message}`, true);
  } finally {
    sidebarRestartBusy = false;
    updateSidebarRestart();
  }
});

function updateSidebarShutdown() {
  const button = $('sidebar-shutdown');
  button.hidden = !info?.supports_shutdown;
  button.disabled = sidebarShutdownBusy || !info?.supports_shutdown;
}

$('sidebar-shutdown').addEventListener('click', async () => {
  if (sidebarShutdownBusy || !info?.supports_shutdown || $('confirm').open) return;
  if (!await confirmAction('确认关机', '机器人将先坐下并收回姿态，然后关闭系统。')) return;
  sidebarShutdownBusy = true;
  updateSidebarShutdown();
  try {
    await request('shutdown', {});
    toast('已发送关机请求');
  } catch (error) {
    toast(error.message, true);
    sidebarShutdownBusy = false;
    updateSidebarShutdown();
  }
});

function updateSidebarRelease() {
  $('sidebar-release').disabled = sidebarReleaseBusy || !info || info.readonly;
}

$('sidebar-release').addEventListener('click', async () => {
  if (sidebarReleaseBusy) return;
  if (!await confirmRelease()) return;
  sidebarReleaseBusy = true;
  updateSidebarRelease();
  controlGeneration++;
  setArmed(false);
  notifyFrames('studio-emergency-release', { active: true });
  const hadAction = controlActionActive || controlActionStarting;
  const runId = hadAction && (controlActionActive || controlActionStartSent) ? controlActionRunId : null;
  const settled = controlActionSettled;
  if (hadAction) controlActionGeneration++;
  const resumeControl = () => {
    if (workspace === 'control' && !switchingWorkspace && !controlActionPageHidden) {
      notifyFrames('studio-workspace', { page: workspace });
    }
  };
  try {
    const result = await request('emergency-release', runId ? { run_id: runId } : {});
    if (result.verified !== true) {
      const failures = Object.entries(result.results || {}).filter(([, value]) => value !== '已读回关闭')
        .map(([id, value]) => `ID ${id}: ${value}`).join('；');
      throw new Error(failures || result.error || '未确认全部舵机卸力');
    }
    if (hadAction) {
      finishControlAction({ state: 'stopped', active: false, error: '已请求卸力' }, false);
      if (controlActionStarting) settled.then(resumeControl); else resumeControl();
    }
    const message = result.already_released ? '校准前已确认关节卸力' : '关节已卸力并读回确认';
    $('last-command').textContent = message;
    toast(message);
  } catch (error) {
    if (hadAction && controlActionRunId) {
      let stopped = false;
      try { stopped = !(await stopControlAction(false)).active; }
      catch (stopError) { error = new Error(`${error.message}；动作停止未确认：${stopError.message}`); }
      if (stopped) {
        if (controlActionStarting) settled.then(resumeControl); else resumeControl();
      }
    }
    toast(`关节卸力失败：${error.message}`, true);
  } finally {
    sidebarReleaseBusy = false;
    notifyFrames('studio-emergency-release', { active: false });
    updateSidebarRelease();
  }
});

window.addEventListener('message', event => {
  const debug = $('debug-frame'), control = $('control-workspace');
  if (event.origin === location.origin && event.source === debug.contentWindow && workspace === 'debug') {
    if (event.data?.type === 'studio-servo-selected' && Number.isInteger(event.data.id)) {
      selected = [event.data.id];
      highlightSelectedJoints();
    } else if (event.data?.type === 'studio-debug-size' && Number.isFinite(event.data.height)
        && window.matchMedia('(max-width:999px)').matches) {
      debug.style.height = `${Math.ceil(event.data.height)}px`;
    } else if (event.data?.type === 'studio-feedback' && typeof event.data.text === 'string' && typeof event.data.error === 'boolean') {
      toast(event.data.text, event.data.error, { routine: event.data.routine === true });
    }
  } else if (controlPages.has(workspace) && control.src && control.src !== 'about:blank'
      && event.source === control.contentWindow && event.origin === new URL(control.src).origin) {
    if (event.data?.type === 'studio-feedback' && typeof event.data.text === 'string' && typeof event.data.error === 'boolean') {
      toast(event.data.text, event.data.error, { routine: event.data.routine === true,
        source: event.data.source === 'settings-status' ? 'control:settings-status' : null });
    } else if (event.data?.type === 'studio-feedback-clear' && event.data.source === 'settings-status') {
      toast.clearRoutine('control:settings-status');
    } else if (event.data?.type === 'studio-action-request') {
      controlAction(event);
    } else if (event.data?.type === 'studio-network-announcement-request') {
      networkAnnouncementSetting(event);
    } else if (event.data?.type === 'studio-software-update-request') {
      checkSoftwareUpdate();
    }
  }
});

function loadWorkspaceFrame(frame, url) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => finish(new Error('页面加载超时，请重试')), 15000);
    function finish(error) {
      clearTimeout(timer);
      frame.removeEventListener('load', loaded);
      if (error) reject(error); else resolve();
    }
    function loaded() { finish(); }
    frame.addEventListener('load', loaded);
    frame.src = url;
  });
}

function loadControlFrame() {
  const frame = $('control-workspace');
  if (controlFrameLoad) return controlFrameLoad;
  if (frame.getAttribute('src') && frame.getAttribute('src') !== 'about:blank') return Promise.resolve();
  const url = new URL(location.href);
  url.port = location.protocol === 'https:' ? '9444' : '8081';
  url.pathname = '/';
  url.search = `?studio=1&theme=${document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light'}&debug=${Number(sidebarDebugMode.checked)}&lang=${getLanguage()}`;
  url.hash = '';
  controlFrameLoad = loadWorkspaceFrame(frame, url.href).catch(error => {
    frame.classList.add('frame-clearing');
    frame.src = 'about:blank';
    throw error;
  }).finally(() => { controlFrameLoad = null; });
  return controlFrameLoad;
}

let controlWorkspaceRequestId = 0;
let controlFrameActive = false;
let controlFrameLoad = null;
function activateControlWorkspace(page, enabled = true) {
  const frame = $('control-workspace');
  const origin = new URL(frame.src).origin;
  const requestId = ++controlWorkspaceRequestId;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => finish(new Error('页面准备超时，请重试')), 5000);
    function receive(event) {
      if (event.source !== frame.contentWindow || event.origin !== origin
          || event.data?.type !== 'studio-workspace-ready' || event.data.requestId !== requestId
          || event.data.page !== page) return;
      finish();
    }
    function finish(error) {
      clearTimeout(timer);
      window.removeEventListener('message', receive);
      if (error) reject(error); else resolve();
    }
    window.addEventListener('message', receive);
    controlFrameActive = enabled;
    frame.contentWindow.postMessage({ type: 'studio-workspace', page, requestId, enabled }, origin);
  });
}

function clearDebugFrame() {
  const frame = $('debug-frame');
  frame.classList.add('frame-clearing');
  if (frame.getAttribute('src') !== 'about:blank') frame.src = 'about:blank';
}

let debugPreviewLoad = null;
function previewDebugFrame() {
  const frame = $('debug-frame');
  if (debugPreviewLoad) return debugPreviewLoad;
  if (frame.getAttribute('src') === '/debug.html?preview=1' && !frame.classList.contains('frame-clearing')) return;
  debugPreviewLoad = loadWorkspaceFrame(frame, '/debug.html?preview=1').then(() => {
    if (document.body.dataset.workspace === 'debug' && !document.body.dataset.studioReady
        && frame.getAttribute('src') === '/debug.html?preview=1') {
      frame.classList.remove('frame-clearing');
      notifyFrames('studio-language', { language: getLanguage() });
      notifyFrames('studio-theme', { theme: document.documentElement.dataset.theme });
      notifyFrames('studio-workspace', { page: 'debug' });
    }
  }).catch(error => console.debug('舵机调试预览不可用', error.message))
    .finally(() => { debugPreviewLoad = null; });
  return debugPreviewLoad;
}

async function showControlPreview(page) {
  const frame = $('control-workspace');
  await loadControlFrame();
  if (document.body.dataset.workspace !== page || controlFrameActive) return;
  notifyFrames('studio-workspace-preview', { page });
  frame.classList.remove('frame-clearing');
}

let workspaceNoticeTimer = null;
$('workspace-notice-close').addEventListener('click', () => {
  clearTimeout(workspaceNoticeTimer);
  $('workspace-notice').hidden = true;
});

function previewWorkspace(page, message, ready = false, dismissible = false) {
  document.body.dataset.workspace = page;
  for (const choice of document.querySelectorAll('button[data-workspace]')) {
    const active = choice.dataset.workspace === page;
    choice.classList.toggle('active', active);
    if (active) choice.setAttribute('aria-current', 'page'); else choice.removeAttribute('aria-current');
  }
  const control = $('control-workspace');
  if (controlPages.has(page) && !ready) {
    const hasFrame = control.src && control.src !== 'about:blank';
    control.classList.toggle('frame-clearing', !hasFrame);
  }
  control.hidden = !controlPages.has(page);
  control.inert = !ready;
  $('monitor').hidden = controlPages.has(page) || page === 'network' || page === 'models';
  $('network-workspace').hidden = page !== 'network';
  $('network-workspace').inert = !ready;
  $('models-workspace').hidden = page !== 'models';
  $('models-workspace').inert = !ready;
  for (const panel of document.querySelectorAll('[data-workspace-panel]')) {
    panel.hidden = panel.dataset.workspacePanel !== page;
    panel.inert = !ready;
  }
  updateCameraPreview(page);
  const notice = $('workspace-notice');
  clearTimeout(workspaceNoticeTimer);
  notice.hidden = !message;
  $('workspace-notice-message').textContent = message || '';
  $('workspace-notice-close').hidden = !message || !dismissible;
  if (message && dismissible) workspaceNoticeTimer = setTimeout(() => { notice.hidden = true; }, 8000);
}

function queueWorkspace(page) {
  queuedWorkspace = page;
  delete document.body.dataset.studioReady;
  setArmed(false);
  previewWorkspace(page, '正在准备页面，设备操作暂不可用');
  if (info?.studio && controlPages.has(page) && !controlFrameActive) {
    showControlPreview(page).catch(error => console.debug('操控预览不可用', error.message));
  } else if (info?.studio && page === 'debug') {
    previewDebugFrame();
  }
  if (workspaceQueueTimer) return;
  const retry = () => {
    workspaceQueueTimer = null;
    if (switchingWorkspace || servoDebugMode.busy() || controlActionStarting) {
      workspaceQueueTimer = setTimeout(retry, 200);
      return;
    }
    const target = queuedWorkspace;
    queuedWorkspace = null;
    if (target) selectWorkspace(target);
  };
  workspaceQueueTimer = setTimeout(retry, 0);
}

async function selectWorkspace(next) {
  if (switchingWorkspace || servoDebugMode.busy() || controlActionStarting) { queueWorkspace(next); return; }
  if (next === workspace && (!info?.studio || document.body.dataset.studioReady) && !statusReleaseUnconfirmed) return;
  switchingWorkspace = true;
  sidebarTransitionPending = !!state && state.online && stateFresh();
  servoDebugMode.update();
  const previous = workspace;
  const wasReady = !!document.body.dataset.studioReady;
  const restBefore = !!info?.studio && restBeforeWorkspace.has(next) &&
    (previous !== next || !wasReady || statusReleaseUnconfirmed);
  if (previous !== next) advanceHeadSubscription();
  const pauseCalibration = previous === 'calibration' && previous !== next;
  if (pauseCalibration) calibrationCharts.setActive(false);
  let restFallback = false;
  let statusWarning = '';
  let releaseUnconfirmed = false;
  let initialPreview;
  if (info?.studio) {
    delete document.body.dataset.studioReady;
    controlGeneration++;
    setArmed(false);
    if (previous === 'debug' && previous !== next) clearDebugFrame();
    previewWorkspace(next, '正在准备页面，设备操作暂不可用');
    if (controlPages.has(next) && !controlFrameActive) {
      initialPreview = showControlPreview(next).then(() => null, error => error);
    } else if (next === 'debug' && previous !== 'debug') {
      initialPreview = previewDebugFrame();
    }
  }
  try {
    if (previous === 'control' && previous !== next && controlActionActive) {
      try { await stopControlAction(false); } catch (error) { console.warn('停止动作时切换页面', error); }
    }
    if (previous === 'action' && previous !== next) {
      try { await servoDebugMode.closeOnLeave(); } catch (error) { console.warn('关闭舵机调试模式时切换页面', error); }
    }
    if (info?.studio) {
      if (previous === 'action' && previous !== next && wasReady) await releaseControl();
      if (previous !== next && controlPages.has(previous)) {
        const leaving = leaveControlWorkspace();
        const visible = document.body.dataset.workspace;
        if (controlPages.has(visible)) initialPreview = showControlPreview(visible).then(() => null, error => error);
        try { await leaving; } catch (error) { console.warn('退出操控页面时继续交接', error); }
      }
      if (previous === 'debug' && previous !== next) clearDebugFrame();
      if (restBefore) toast('正在准备进入页面，请稍候', false, { routine: true });
      const result = await request('workspace', { workspace: next, ...(restBefore ? { rest_before: true } : {}) });
      restFallback = result?.rest_fallback === true;
      if (result?.ready === false) throw new Error(result.error || '设备操作尚未就绪');
      if (next === 'status' && result?.ready !== true) throw new Error(result?.error || '设备状态采集尚未就绪');
      if (maintenancePages.has(next) && result?.maintenance !== true
          && !(result?.readonly === true && result?.release_unconfirmed === true)) {
        throw new Error(result?.error || '维护工作区尚未就绪');
      }
      if (result?.release_unconfirmed === true) {
        releaseUnconfirmed = true;
        statusWarning = `${friendlyErrorMessage(result.warning || '卸力未确认')} 当前页面仅可查看。`;
      } else if (next !== 'calibration' && result?.partial === true && Array.isArray(result.unavailable_ids)) {
        statusWarning = `ID ${result.unavailable_ids.join('、')} 未连接，其他舵机可正常操作。`;
      }
      info = await request('info');
      token = info.token;
    }
    if (queuedWorkspace && queuedWorkspace !== next) {
      workspace = next;
      highlightSelectedJoints();
      statusReleaseUnconfirmed = releaseUnconfirmed;
      workspaceRetryRequired = false;
      return;
    }
    if (queuedWorkspace === next) queuedWorkspace = null;
    const control = $('control-workspace');
    const previewError = await initialPreview;
    if (controlPages.has(next)) {
      if (previewError) throw previewError;
      await showControlPreview(next);
    }
    if (next === 'debug' && (previous !== 'debug' || !$('debug-frame').src || $('debug-frame').src === 'about:blank'
        || Boolean($('debug-frame').getAttribute('src')?.includes('preview=1')) !== Boolean(info?.readonly))) {
      await loadWorkspaceFrame($('debug-frame'), info?.readonly ? '/debug.html?preview=1' : '/debug.html');
      $('debug-frame').classList.remove('frame-clearing');
    }
    workspace = next;
    highlightSelectedJoints();
    statusReleaseUnconfirmed = releaseUnconfirmed;
    if (controlPages.has(workspace)) {
      notifyFrames('studio-language', { language: getLanguage() });
      notifyFrames('studio-theme', { theme: document.documentElement.dataset.theme });
      syncDebugMode();
      await activateControlWorkspace(workspace);
      if (queuedWorkspace && queuedWorkspace !== next) {
        workspaceRetryRequired = false;
        return;
      }
      control.classList.remove('frame-clearing');
    }
    document.body.dataset.studioReady = 'true';
    previewWorkspace(workspace, statusWarning, true, !!statusWarning);
    if (restFallback) toast('休息未完成，已关闭策略并卸力');
    else if (restBefore && !statusWarning) toast('页面已就绪', false, { routine: true });
    workspaceRetryRequired = false;
    networkControls.setActive(workspace === 'network');
    modelControls.setActive(workspace === 'models');
    if (controlPages.has(workspace)) {
      notifyFrames('studio-device-versions', { versions: info?.device_versions || null, softwareUpdate: info?.supports_software_update, busy: softwareUpdateBusy });
    }
    if (controlPages.has(previous) && !controlPages.has(workspace)) {
      control.classList.add('frame-clearing');
      control.src = 'about:blank';
    }
    if (previous === 'debug' && workspace !== 'debug') {
      clearDebugFrame();
      $('debug-frame').style.height = '';
      selected = [];
      highlightSelectedJoints();
    }
    if (workspace === 'debug') {
      notifyFrames('studio-language', { language: getLanguage() });
      notifyFrames('studio-workspace', { page: workspace });
    }
    calibrationCharts.setActive(workspace === 'calibration');
    calibrationView.setActive(workspace === 'calibration');
    updateReferenceView();
    if (workspace === 'action') {
      renewControl();
      if (info?.studio && !info.readonly) actionEditor.refreshGroups().catch(error => toast(error.message, true));
    }
    if (window.matchMedia('(max-width:720px)').matches) setSidebarOpen(false);
    if (state && info) renderState();
    drawChart();
  } catch (error) {
    console.warn('页面切换失败', error);
    const message = `${friendlyErrorMessage(error.message)} 设备操作暂不可用，请重新点击当前页面重试。`;
    if ((next === 'debug' || previous === 'debug')
        && $('debug-frame').getAttribute('src') !== '/debug.html?preview=1') clearDebugFrame();
    if (controlFrameActive && controlPages.has(next)) {
      await leaveControlWorkspace().catch(error => console.debug('退出操控页面', error.message));
    }
    workspace = next;
    highlightSelectedJoints();
    statusReleaseUnconfirmed = false;
    delete document.body.dataset.studioReady;
    workspaceRetryRequired = true;
    setArmed(false);
    if (queuedWorkspace && queuedWorkspace !== next) return;
    if (queuedWorkspace === next) queuedWorkspace = null;
    previewWorkspace(workspace, message, false, true);
    if (controlPages.has(workspace)) {
      try {
        await loadControlFrame();
        await activateControlWorkspace(workspace, false);
        $('control-workspace').classList.remove('frame-clearing');
        notifyFrames('studio-device-versions', { versions: info?.device_versions || null, softwareUpdate: info?.supports_software_update, busy: softwareUpdateBusy });
      } catch (previewError) {
        console.debug('操控页面预览不可用', previewError.message);
      }
    }
    if (workspace === 'debug') previewDebugFrame();
    networkControls.setActive(false);
    modelControls.setActive(false);
    calibrationCharts.setActive(false);
    calibrationView.setActive(workspace === 'calibration');
    updateReferenceView();
    if (state && info) renderState();
  } finally {
    switchingWorkspace = false;
    if (sidebarTransitionPending) sidebarTransitionCompleted = performance.now();
    servoDebugMode.update();
    $('control-workspace').inert = !!info?.studio && !document.body.dataset.studioReady;
    if (pendingWorkspaceResume) {
      pendingWorkspaceResume = false;
      restoreWorkspaceOnVisible();
    }
  }
}

$('control-workspace').addEventListener('load', () => {
  if (switchingWorkspace || !document.body.dataset.studioReady || !controlPages.has(workspace)) return;
  notifyFrames('studio-theme', { theme: document.documentElement.dataset.theme });
  syncDebugMode();
  notifyFrames('studio-workspace', { page: workspace });
  notifyFrames('studio-device-versions', { versions: info?.device_versions || null, softwareUpdate: info?.supports_software_update, busy: softwareUpdateBusy });
});
$('debug-frame').addEventListener('load', () => notifyFrames('studio-theme', { theme: document.documentElement.dataset.theme }));
for (const button of document.querySelectorAll('button[data-workspace]')) {
  button.addEventListener('click', () => selectWorkspace(button.dataset.workspace));
}

setInterval(() => {
  if (info?.studio && !info.readonly && state?.maintenance_owner && document.body.dataset.studioReady && maintenancePages.has(workspace) && !document.hidden && !switchingWorkspace && !workspaceRestoreInFlight) {
    request('workspace', { operation: 'heartbeat' }).catch(error => { setArmed(false); toast(error.message, true); });
  }
}, 5000);
window.addEventListener('pageshow', () => { controlActionPageHidden = false; });
window.addEventListener('pagehide', () => {
  controlActionPageHidden = true;
  controlActionGeneration++;
  if ((controlActionActive || controlActionStarting) && controlActionRunId && token) {
    fetch('/api/control-actions', { method: 'POST', headers: requestHeaders(),
      body: JSON.stringify({ operation: 'stop', run_id: controlActionRunId }), keepalive: true })
      .catch(error => console.debug('动作停止请求未送达', error.message));
  }
  if (info?.studio && (workspace === 'status' || maintenancePages.has(workspace) || restrictedPages.has(workspace)) && token) {
    advanceHeadSubscription();
    fetch('/api/workspace', { method: 'POST', headers: requestHeaders(), body: JSON.stringify({ workspace: 'system' }), keepalive: true })
      .catch(error => console.debug('工作区关闭请求未送达', error.message));
  }
});

function renderTof() {
  const tof = tofStatus(state?.tof, sampleElapsed(), connectionError, info?.studio === true);
  $('tof-reading').dataset.status = tof.kind;
  $('tof-reading').title = [tof.detail, tof.raw].filter(Boolean).join(' · ');
  const hasDistance = tof.kind === 'ok';
  const value = hasDistance ? tof.distance : tof.label;
  if ($('tof-distance').textContent !== value) $('tof-distance').textContent = value;
}

function renderState() {
  if (state.joints.length !== info.joints.length || state.joints.some((joint, index) => joint.id !== info.joints[index].id)) {
    info.joints = state.joints;
    servoPanel.reset(info.joints);
    actionEditor.render();
  }
  calibrationControls.render(state.calibration, info?.demo, state.imu_source, state.head_calibration, state.aux_imu);
  calibrationCharts.updateState(state, connectionError);
  calibrationView.update(state, sampleElapsed(), connectionError);
  const fresh = stateFresh();
  const valid = imuFresh(state.imu, state, sampleElapsed(), connectionError) && validQuaternion(state.imu.quaternion_wxyz);
  const deviceReportsFresh = state.online && Number.isFinite(state.device_report_age_ms) &&
    state.device_report_age_ms + sampleElapsed() < SAMPLE_MAX_AGE_MS;
  const useIndependentStatus = Number.isFinite(state.device_report_age_ms) && !state.device_paused;
  const sidebarState = state.control_servos && !info?.readonly && !useIndependentStatus ? { ...state, online: state.control_online, error: state.control_error,
    servos: state.control_servos } : state;
  const sidebarFresh = useIndependentStatus
    ? !connectionError && sidebarState.online && sidebarState.device_report_age_ms >= 0
      && sidebarState.device_report_age_ms + sampleElapsed() < SERVO_STATUS_MAX_AGE_MS
    : sampleFresh(sidebarState, sampleElapsed(), connectionError);
  const sidebarServoAge = Number.isFinite(sidebarState.device_report_age_ms) ? SERVO_STATUS_MAX_AGE_MS : SAMPLE_MAX_AGE_MS;
  const servoKinds = sidebarState.servos.map(servo => servoStatus(servo, sidebarState, sampleElapsed(), connectionError, sidebarServoAge).kind);
  const faults = servoKinds.includes('fault');
  const communication = servoKinds.includes('communication');
  const timeout = servoKinds.includes('timeout');
  const missing = servoKinds.filter(kind => kind === 'offline').length;
  const invalid = servoKinds.includes('invalid');
  const stale = servoKinds.includes('stale');
  // A handoff can block requests or return a controller before its first sample.
  const transitionHandoff = switchingWorkspace || (sidebarTransitionPending
    && performance.now() - sidebarTransitionCompleted < SAMPLE_MAX_AGE_MS);
  const playbackSamplingPaused = state.action_playback?.state === 'playing' && state.online && !state.error && !connectionError;
  const handoff = transitionHandoff || stateRequestPending || playbackSamplingPaused;
  const measuredVoltages = workspace === 'status' && !state.device_paused
    ? state.servos.filter(servo => liveServoFresh(servo)).map(servo => servo.voltage)
    : [];
  const lowVoltage = updateLowVoltage(state.robot?.low_voltage, measuredVoltages, performance.now());
  renderSidebarCpu($, connectionError ? null : state.robot?.health);
  if (!(handoff && !connectionError && ((state.online && !fresh) || waitingForFirstSample(state)))) {
    const voltage = displayVoltage(state, sampleElapsed(), connectionError);
    const calibrating = !!state.calibration?.active || !!state.head_calibration?.active;
    const warning = lowVoltageWarning(lowVoltage);
    renderSidebarVoltage($, { calibrating, voltage, fresh: sidebarFresh, lowVoltage });
    if (warning && !lowVoltageActive && performance.now() - lastLowVoltageNotice >= 10000) {
      lastLowVoltageNotice = performance.now();
      toast(lowVoltage?.display_only ? '电压过低，请及时充电'
        : '电压过低，请及时充电；持续低压将坐下并卸力', true);
    }
    lowVoltageActive = warning;
    const imuWorkspace = workspace === 'calibration';
    const imuOnline = calibrating || valid || auxImuStatus(state.aux_imu, sampleElapsed(), connectionError).valid;
    const connectionStatus = connectionError ? '连接中断' : imuWorkspace ? (imuOnline ? '设备在线' : '等待采样')
      : !sidebarState.online ? '采集异常' : !sidebarFresh ? '数据过期'
      : faults ? '舵机故障' : communication ? '总线通信异常' : timeout ? '舵机读取超时'
        : missing === info.joints.length ? '舵机未连接' : missing ? '部分舵机未连接'
        : invalid ? '舵机数据异常' : stale ? '设备数据过期'
          : (info.readonly ? 'robotd · 只读' : info.demo ? '演示连接' : '设备在线');
    const sidebarOnline = imuWorkspace ? imuOnline : sidebarFresh && !faults && !communication && !timeout && !missing && !invalid && !stale;
    setConnectionStatus(connectionStatus, !connectionError && sidebarOnline ? 'live' : 'error',
      connectionError || (imuWorkspace ? '' : sidebarState.error) || '');
  }
  const heldAngles = !valid && state.imu?.valid && state.online && !state.device_paused &&
    !state.calibration?.active && !connectionError && $('curve-roll').textContent !== '--';
  setText('pose-status', state.device_paused ? '维护占用' : state.calibration?.active ? '标定中'
    : state.imu_source === 'compare' ? (state.imu_comparison?.valid ? '双路有效' : '对比中')
      : valid ? '正常' : heldAngles ? '数据过期' : 'IMU 无效');
  $('pose-status').title = state.imu_source === 'compare'
    ? [state.imu_sources?.id200?.error, state.imu_sources?.i2c?.error].filter(Boolean).join('；')
    : state.imu?.error || state.error || '';
  const angles = valid ? quaternionAngles(state.imu.quaternion_wxyz) : [null, null, null];
  $('chart').closest('.chart-layout').classList.toggle('historical', heldAngles);
  renderTof();
  for (const [index, id] of ['roll', 'pitch', 'yaw'].entries()) {
    if (!heldAngles) {
      const text = fmt(angles[index]);
      const curve = $(`curve-${id}`);
      const label = valid ? `${text}°` : '--';
      if (curve.textContent !== label) curve.textContent = label;
    }
  }
  setText('bus-rate-label', state.readonly ? '状态订阅' : '总线采集');
  setText('bus-rate', `${state.hz} Hz`);
  setText('failures-label', state.readonly ? '订阅异常' : '失败轮次');
  setText('failures', state.failures);
  renderImuComparison();
  const auxiliary = auxImuStatus(state.aux_imu, sampleElapsed(), connectionError);
  if (!document.hidden && (workspace === 'status' || workspace === 'calibration' && calibrationControls.source() === 'head') &&
      ['stale', 'pending'].includes(auxiliary.kind) && performance.now() - lastHeadDiagnostic >= 10000) {
    lastHeadDiagnostic = performance.now();
    console.warn('头部 IMU 过期诊断', { backend_status: state.aux_imu?.status, backend_age_ms: state.aux_imu?.age_ms,
      elapsed_ms: sampleElapsed(), poll_interval_ms: Math.round(statePollInterval),
      request_ms: Math.round(stateRequestDuration), render_ms: Math.round(stateRenderDuration),
      pending_request: stateRequestPending,
      pending_request_ms: stateRequestPending ? Math.round(performance.now() - stateRequestStarted) : null });
  }
  auxValid = auxiliary.valid;
  if (workspace === 'status') {
    const statuses = deviceStatus.render(info, state, fresh, sampleElapsed(), connectionError, auxiliary, transitionHandoff, lowVoltage,
      displayVoltage(state, sampleElapsed(), connectionError));
    jointHighlighter.setStatuses(statuses);
    $('model-servo-alert').hidden = !jointHighlighter.hasIssues();
  }
  if (workspace === 'action' && (!info.studio || (state.workspace === 'action' && state.maintenance_owner))) {
    referenceView?.setTargets(state.pose_targets, info.joints);
  }
  updateControls();
  const imuKey = `${state.imu?.t_ns ?? state.sequence}:${valid}`;
  if (workspace === 'status' && imuKey !== lastImuKey) {
    const captured = valid ? lastGood - state.imu.age_ms : performance.now();
    const time = Math.max(samples.at(-1)?.time ?? 0, captured);
    samples.push({ time, angles: valid ? angles.map(angle => Number(angle.toFixed(1))) : null,
      maxGapMs: Number.isFinite(state.device_report_age_ms) ? INDEPENDENT_IMU_MAX_AGE_MS : 600 });
    lastImuKey = imuKey;
    while (samples.length && samples[0].time < performance.now() - 20000) samples.shift();
  }
  if (workspace === 'status' && responseSequence !== lastAuxSequence) {
    auxSamples.push({ time: performance.now(),
      angles: auxiliary.valid ? state.aux_imu.rpy_deg.map(value => Number(value.toFixed(1))) : null,
      reset_count: auxiliary.valid ? state.aux_imu.reset_count : null });
    lastAuxSequence = responseSequence;
    while (auxSamples.length && auxSamples[0].time < performance.now() - 20000) auxSamples.shift();
  }
  if (valid) {
    const [w, x, y, z] = state.imu.quaternion_wxyz;
    attitudeTarget.set(x, y, z, w).normalize();
  }
  for (const servo of state.servos) {
    const joint = rigJoints.get(servo.name);
    if (joint && liveServoFresh(servo) && Number.isFinite(servo.radians)) {
      joint.target.setFromAxisAngle(joint.axis, servo.radians);
    }
  }
  if (fresh || deviceReportsFresh) {
    initializeModelPlacement();
  }
}

async function poll() {
  const started = performance.now();
  statePollInterval = previousStateStarted ? started - previousStateStarted : 0;
  previousStateStarted = started;
  if (!document.hidden && (workspace === 'status' || workspace === 'calibration' && calibrationControls.source() === 'head') &&
      statePollInterval > 500 && started - lastHeadDiagnostic >= 10000) {
    lastHeadDiagnostic = started;
    console.warn('头部 IMU 页面请求间断', { poll_interval_ms: Math.round(statePollInterval),
      previous_request_ms: Math.round(stateRequestDuration), previous_render_ms: Math.round(stateRenderDuration),
      backend_status: state?.aux_imu?.status, backend_age_ms: state?.aux_imu?.age_ms });
  }
  if (workspace === 'status' && !document.hidden && !resourceRequestPending && started >= nextResourceRequest) {
    resourceRequestPending = true;
    nextResourceRequest = started + 5000;
    request('resources').then(data => deviceStatus.renderResources(data))
      .catch(() => deviceStatus.renderResources(null))
      .finally(() => { resourceRequestPending = false; });
  }
  stateRequestPending = true;
  stateRequestStarted = started;
  try {
    state = await request('state');
    stateRequestDuration = performance.now() - started;
    stateRequestPending = false;
    lastGood = performance.now();
    responseSequence++;
    connectionError = '';
    if (!switchingWorkspace && (stateFresh() || (!state.online && !waitingForFirstSample(state)))) {
      sidebarTransitionPending = false;
    }
    if (armed && !state.armed && started > controlUpdatedAt) { setArmed(false); nextControlAttempt = 0; }
    if (!armed) renewControl();
    const renderStarted = performance.now();
    renderState();
    stateRenderDuration = performance.now() - renderStarted;
  } catch (e) {
    stateRequestPending = false;
    sidebarTransitionPending = false;
    connectionError = e.message;
    if (state) renderState(); else renderTof();
    setConnectionStatus('连接中断', 'error', connectionError);
    $('pose-status').textContent = '数据已停止';
    setArmed(false); nextControlAttempt = 0; updateControls();
  } finally {
    const period = info?.studio ? 1000 / info.hz : 20;
    setTimeout(poll, document.hidden ? 1000 : Math.max(0, period - (performance.now() - started)));
  }
}

setInterval(() => {
  if (state && ((!stateFresh() && !state.calibration?.active && !state.head_calibration?.active &&
      !['数据过期', '采集异常', '连接中断'].map(translate).includes($('connection').textContent)) ||
      auxImuStatus(state.aux_imu, sampleElapsed(), connectionError).valid !== auxValid)) renderState();
}, 100);

function drawChart() {
  drawTrace($('chart'), samples);
  drawTrace($('aux-chart'), auxValid ? auxSamples : []);
}

function drawTrace(canvas, history) {
  const width = canvas.clientWidth, height = canvas.clientHeight;
  if (!width || !height) return;
  const style = getComputedStyle(document.documentElement);
  const chartColor = name => style.getPropertyValue(name).trim();
  const axisColors = ['--chart-roll', '--chart-pitch', '--chart-yaw'].map(chartColor);
  const dpr = Math.min(devicePixelRatio, 1.5);
  const pixelWidth = Math.floor(width * dpr), pixelHeight = Math.floor(height * dpr);
  if (canvas.width !== pixelWidth || canvas.height !== pixelHeight) {
    canvas.width = pixelWidth; canvas.height = pixelHeight;
  }
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, width, height);
  const points = history.filter(p => p.time > performance.now() - 20000);
  const left = 6, right = width - 38, laneHeight = (height - 20) / 3;
  const now = performance.now();
  for (let axis = 0; axis < 3; axis++) {
    const values = points.filter(p => p.angles).map(p => p.angles[axis]);
    const minimum = values.length ? Math.min(...values) : -5;
    const maximum = values.length ? Math.max(...values) : 5;
    const middle = (minimum + maximum) / 2;
    const halfRange = Math.max(5, (maximum - minimum) * .6);
    const top = axis * laneHeight + 5, bottom = (axis + 1) * laneHeight - 5;
    const center = (top + bottom) / 2;
    ctx.strokeStyle = chartColor('--chart-grid'); ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(left, center); ctx.lineTo(right, center); ctx.stroke();
    ctx.font = `11px ${fontFamily}`; ctx.fillStyle = chartColor('--chart-text'); ctx.textAlign = 'right';
    ctx.fillText(fmt(middle + halfRange), width - 1, top + 8);
    ctx.fillText(fmt(middle - halfRange), width - 1, bottom);
    ctx.save(); ctx.beginPath(); ctx.rect(left, top, right - left, bottom - top); ctx.clip();
    ctx.strokeStyle = axisColors[axis]; ctx.lineWidth = 1.5; ctx.beginPath();
    let prev = null;
    for (const p of points) {
      if (!p.angles) { prev = null; continue; }
      const x = left + (right - left) * (1 - (now - p.time) / 20000);
      const y = center - (p.angles[axis] - middle) / halfRange * (bottom - top) / 2;
      if (!imuTraceContinues(prev, p, axis, p.maxGapMs)) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
      prev = p;
    }
    ctx.stroke();
    ctx.restore();
  }
  ctx.font = `11px ${fontFamily}`; ctx.fillStyle = chartColor('--chart-text'); ctx.textAlign = 'left';
  ctx.fillText('-20 s', left, height - 3); ctx.fillText('0 s', right - 17, height - 3);
}
const viewer = $('viewer');
let calibrationView;
const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(35, 1, .01, 20);
let renderer, controls, trunk, modelRoot, modelPositionTarget, pendingPoseTargets, referenceView;
let alignLiveFeet, modelPlatform;
let modelAsset, modelPlacementReady = false;
const modelPlacementKey = 'console-model-placement';
const rigJoints = new Map();
const jointHighlighter = createJointHighlighter();
const attitudeTarget = new THREE.Quaternion();
function saveModelPlacement(platform) {
  try {
    const offset = modelPositionTarget.clone().sub(platform.position).toArray();
    localStorage.setItem(modelPlacementKey, JSON.stringify({ model: modelAsset, offset }));
  } catch (error) {
    console.error('模型位置保存失败', error);
    toast('模型位置未能保存，刷新后可能需要重新对齐', true);
  }
}
function restoreModelPlacement(platform) {
  try {
    const value = localStorage.getItem(modelPlacementKey);
    if (!value) return;
    const saved = JSON.parse(value);
    if (saved.model !== modelAsset) return;
    if (!Array.isArray(saved.offset) || saved.offset.length !== 3 || !saved.offset.every(Number.isFinite)) {
      throw new Error('保存的模型位置无效');
    }
    modelPositionTarget = new THREE.Vector3(...saved.offset).add(platform.position);
    modelRoot.position.copy(modelPositionTarget);
    modelPlacementReady = true;
  } catch (error) {
    console.error('模型位置恢复失败', error);
    toast('无法恢复保存的模型位置', true);
  }
}
function initializeModelPlacement() {
  if (modelPlacementReady || !modelRoot || !trunk) return;
  const feet = ['left_ankle', 'right_ankle'].map(name => rigJoints.get(name)?.node);
  if (!modelPlatform || feet.some(foot => !foot)) return;
  modelPositionTarget = positionForPose(modelRoot, [], feet, modelPlatform.getWorldPosition(new THREE.Vector3()));
  modelRoot.position.copy(modelPositionTarget);
  modelPlacementReady = true;
}
function alignPoseToPlatform(targets) {
  modelPlacementReady = true;
  pendingPoseTargets = targets;
  if (!modelRoot || !trunk) return;
  try {
    const feet = ['left_ankle', 'right_ankle'].map(name => rigJoints.get(name)?.node);
    const platform = scene.getObjectByName('display-platform');
    if (!platform || feet.some(foot => !foot)) throw new Error('模型缺少双脚或展示台');
    const poses = [];
    for (const [id, raw] of Object.entries(targets)) {
      const name = info.joints.find(joint => joint.id === Number(id))?.name;
      const joint = rigJoints.get(name);
      if (joint) poses.push({ node: joint.node, rotation: new THREE.Quaternion().setFromAxisAngle(
        joint.axis, THREE.MathUtils.degToRad(180 - raw * 360 / 4096)) });
    }
    modelPositionTarget = positionForPose(modelRoot, poses, feet, platform.getWorldPosition(new THREE.Vector3()));
    saveModelPlacement(platform);
    pendingPoseTargets = null;
  } catch (error) {
    console.error('模型贴合失败', error);
    toast(`目标已下发，模型贴合失败：${error.message}`, true);
  }
}
$('model-imu-follow').addEventListener('change', event => {
  if (!event.target.checked && trunk) trunk.quaternion.identity();
});

const modelPaletteMaterials = new Map();
const modelPalettes = {
  white_orange: { body_deep_blue: '#f2f2f2', body_yellow: '#f28c28', body_foot: '#f28c28', body_mouth: '#f28c28', body_black: '#424548' },
  yellow_black: { body_deep_blue: '#ffcf29', body_yellow: '#424548', body_foot: '#ffcf29', body_mouth: '#424548', body_black: '#424548' },
  black_orange: { body_deep_blue: '#424548', body_yellow: '#f28c28', body_foot: '#f28c28', body_mouth: '#f28c28', body_black: '#424548' },
  navy: { body_deep_blue: '#102c60', body_yellow: '#ffcf29', body_foot: '#ffcf29', body_mouth: '#ffcf29', body_black: '#424548' },
};
const separatePaletteVisuals = new Map([
  ['visual_p_left_ankle_01', 'body_foot'],
  ['visual_p_right_ankle_01', 'body_foot'],
  ['visual_p_mouth_01', 'body_mouth'],
]);

function applyModelPalette() {
  const palette = modelPalettes[$('model-palette').value];
  for (const [material, originalColor] of modelPaletteMaterials) {
    const color = palette[material.name];
    if (color === null) material.color.copy(originalColor);
    else material.color.set(color);
  }
  referenceView?.invalidate();
  calibrationView.invalidate();
}
const paletteControl = createModelPaletteControl({
  select: $('model-palette'),
  valid: value => typeof value === 'string' && Object.hasOwn(modelPalettes, value),
  apply: applyModelPalette,
  request,
  onError: error => toast(`模型配色保存失败：${error.message}`, true),
  onLoadError: error => console.warn('读取模型配色失败', error.message),
});
paletteControl.load();

function highlightSelectedJoints() {
  jointHighlighter.setContext(workspace, selected, info?.joints || []);
  $('model-servo-alert').hidden = workspace !== 'status' || !jointHighlighter.hasIssues();
}

function prepareJointHighlights(model) {
  jointHighlighter.prepare(model, rigJoints);
  highlightSelectedJoints();
}

createViewerEnvironment(scene);
scene.add(new THREE.HemisphereLight('#ffffff', '#78887c', 2.8));
const keyLight = new THREE.DirectionalLight('#fffaf0', 3); keyLight.position.set(.6, 1, .5); scene.add(keyLight);
const fillLight = new THREE.DirectionalLight('#e0edff', 1.2); fillLight.position.set(-.7, .4, -.6); scene.add(fillLight);
try {
  try {
    renderer = new THREE.WebGLRenderer({ alpha: true, antialias: true, powerPreference: 'low-power', preserveDrawingBuffer: true });
  } catch (error) {
    console.warn('3D 初始化失败，正在使用兼容设置重试', error);
    renderer = new THREE.WebGLRenderer({ alpha: true, antialias: false, preserveDrawingBuffer: true });
  }
  renderer.setClearColor(0x000000, 0);
  renderer.setPixelRatio(Math.min(devicePixelRatio, 1.5));
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.1;
  viewer.append(renderer.domElement);
  controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true; controls.minDistance = .24; controls.maxDistance = 2.5;
  controls.maxPolarAngle = Math.PI * .85;
  renderer.domElement.addEventListener('webglcontextlost', (e) => { e.preventDefault(); $('model-loading').hidden = false; $('model-loading').textContent = '3D 显示已中断，正在恢复'; toast($('model-loading').textContent, true); });
  renderer.domElement.addEventListener('webglcontextrestored', () => {
    $('model-loading').hidden = !!modelRoot;
    calibrationView?.invalidate();
    referenceView?.invalidate();
    resizeViewer();
  });
} catch (e) {
  console.error('3D 初始化失败', e);
  renderer?.dispose();
  renderer?.domElement.remove();
  renderer = controls = undefined;
  $('model-loading').textContent = '无法初始化 3D 显示，请检查浏览器 WebGL 2 支持';
  toast($('model-loading').textContent, true);
}

calibrationView = createCalibrationView({ viewer, renderer, onError: message => toast(message, true), onRelease: resizeViewer });

if (renderer) {
  referenceView = createActionReferenceView({ viewer, renderer, liveScene: scene, liveCamera: camera,
    liveControls: controls, onResize: resizeViewer });
}
function updateReferenceView() {
  referenceView?.setActive(workspace === 'action' && $('reference-pose').checked);
}
$('reference-pose').addEventListener('change', updateReferenceView);

function resetView() {
  if (controls) { controls.enableDamping = false; controls.update(); }
  camera.position.set(.45, .28, .48);
  controls?.target.set(0, .115, 0);
  controls?.update();
  if (controls) controls.enableDamping = true;
  referenceView?.resetView();
  const size = referenceView?.liveSize() || { width: viewer.clientWidth, height: viewer.clientHeight };
  configureViewerCamera(camera, scene, size.width, size.height);
  referenceView?.resize(configureViewerCamera);
}
function framePlatform(viewCamera, viewScene, width, height) {
  const platform = viewScene.getObjectByName('display-platform');
  if (!width || !height || !platform) return;
  viewCamera.clearViewOffset();
  viewCamera.updateMatrixWorld();
  const center = platform.getWorldPosition(new THREE.Vector3()).project(viewCamera);
  if (!Number.isFinite(center.y)) return;
  const offsetY = ((1 - center.y) / 2 - 3 / 4) * height;
  viewCamera.setViewOffset(width, height, 0, offsetY, width, height);
}
function configureViewerCamera(viewCamera, viewScene, width, height) {
  if (!width || !height) return;
  viewCamera.aspect = width / height;
  viewCamera.fov = THREE.MathUtils.radToDeg(2 * Math.atan(Math.tan(THREE.MathUtils.degToRad(35) / 2)
    * Math.max(1, .78 / viewCamera.aspect)));
  framePlatform(viewCamera, viewScene, width, height);
}
function renderViewer() {
  if (referenceView?.render()) return;
  renderer.setScissorTest(false);
  renderer.setViewport(0, 0, viewer.clientWidth, viewer.clientHeight);
  renderer.render(scene, camera);
}
function resizeViewer() {
  if (!renderer || !viewer.clientWidth || workspace === 'calibration') return;
  const height = Math.max(1, viewer.clientHeight);
  renderer.domElement.style.top = '0';
  renderer.domElement.style.height = `${height}px`;
  const size = referenceView?.liveSize() || { width: viewer.clientWidth, height };
  configureViewerCamera(camera, scene, size.width, size.height);
  referenceView?.resize(configureViewerCamera);
  renderer.setSize(viewer.clientWidth, height, false);
  renderViewer();
}
const viewerObserver = new ResizeObserver(() => { resizeViewer(); drawChart(); });
viewerObserver.observe(viewer);
const chartObserver = new ResizeObserver(drawChart);
chartObserver.observe($('chart'));
chartObserver.observe($('aux-chart'));
handle('reset-view', resetView);

async function loadModel() {
  if (!renderer) return;
  try {
    const response = await fetch(modelConfigUrl);
    if (!response.ok) throw new Error('模型配置读取失败');
    const config = await response.json();
    const gltf = await new GLTFLoader().loadAsync(`/assets/imu-viewer-resources/${config.model}`);
    modelAsset = config.model;
    modelRoot = gltf.scene;
    trunk = gltf.scene.getObjectByName(config.root_node);
    if (!trunk) throw new Error('模型缺少机身节点');
    gltf.scene.position.y = config.home_trunk_height_m;
    scene.add(gltf.scene);
    for (const joint of config.joints) {
      const node = gltf.scene.getObjectByName(joint.node);
      if (!node) throw new Error(`模型缺少关节 ${joint.name}`);
      rigJoints.set(joint.name, { node, axis: new THREE.Vector3(...joint.axis), target: node.quaternion.clone() });
    }
    modelPlatform = scene.getObjectByName('display-platform');
    alignLiveFeet = createFootHeightAligner(modelRoot,
      ['left_ankle', 'right_ankle'].map(name => rigJoints.get(name)?.node));
    gltf.scene.traverse(mesh => {
      if (!mesh.isMesh) return;
      const paletteName = separatePaletteVisuals.get(mesh.name);
      if (paletteName) {
        // Feet and mouth share the body material in the model; color them independently.
        const separateMaterial = material => {
          if (material.name !== 'body_yellow') return material;
          const separate = material.clone();
          separate.name = paletteName;
          return separate;
        };
        mesh.material = Array.isArray(mesh.material)
          ? mesh.material.map(separateMaterial) : separateMaterial(mesh.material);
      }
      for (const material of Array.isArray(mesh.material) ? mesh.material : [mesh.material]) {
        if (Object.hasOwn(modelPalettes.navy, material.name)) modelPaletteMaterials.set(material, material.color.clone());
      }
    });
    applyModelPalette();
    referenceView?.setRobotModel(gltf.scene, config);
    prepareJointHighlights(gltf.scene);
    calibrationView.setRobotModel(gltf.scene);
    if (pendingPoseTargets) alignPoseToPlatform(pendingPoseTargets);
    else {
      restoreModelPlacement(scene.getObjectByName('display-platform'));
      initializeModelPlacement();
    }
    const center = modelPlatform.getWorldPosition(new THREE.Vector3());
    alignLiveFeet(center.y);
    centerTrunkOnPlatform(modelRoot, trunk, center);
    if (modelPositionTarget) modelPositionTarget.copy(modelRoot.position);
    $('model-loading').hidden = true;
    resetView(); resizeViewer();
  } catch (e) { $('model-loading').textContent = `模型加载失败：${e.message}`; toast($('model-loading').textContent, true); }
}

let lastFrame = 0;
let lastChartFrame = 0;
function animate(now) {
  requestAnimationFrame(animate);
  if (!document.hidden && workspace === 'status' && now - lastChartFrame >= 16) {
    lastChartFrame = now;
    drawChart();
  }
  if (!renderer || document.hidden || $('monitor').hidden || workspace === 'calibration' || cameraPreview?.expanded || now - lastFrame < 1000 / 30) return;
  const dt = Math.min(.1, (now - lastFrame) / 1000); lastFrame = now;
  if (trunk) {
    const fraction = 1 - Math.exp(-22 * dt);
    if (modelPositionTarget) modelRoot.position.lerp(modelPositionTarget, fraction);
    if (!$('model-imu-follow').checked) trunk.quaternion.identity();
    else if (imuFresh(state?.imu, state, sampleElapsed(), connectionError)) trunk.quaternion.slerp(attitudeTarget, fraction);
    for (const servo of state?.servos || []) {
      const joint = rigJoints.get(servo.name);
      if (joint && liveServoFresh(servo)) joint.node.quaternion.slerp(joint.target, fraction);
    }
    if (alignLiveFeet && modelPlatform) {
      const center = modelPlatform.getWorldPosition(new THREE.Vector3());
      alignLiveFeet(center.y);
      centerTrunkOnPlatform(modelRoot, trunk, center);
      if (modelPositionTarget) modelPositionTarget.copy(modelRoot.position);
    }
  }
  controls?.update();
  renderViewer();
}
requestAnimationFrame(animate);
loadModel();

function applyMode() {
  if (info.readonly) calibrationControls.render({}, false, 'robotd');
  else if (!info.supports_direct_slider) toast('重启控制台服务后启用滑杆直接发送', true);
  updateSidebarRelease();
  updateSidebarShutdown();
  updateSidebarRestart();
  $('demo-badge').hidden = !info.demo;
  for (const element of document.querySelectorAll('.studio-only')) element.hidden = !info.studio;
  for (const page of ['pickup', 'line']) {
    document.querySelector(`[data-workspace="${page}"]`).hidden = !info.studio || !info.workspaces?.includes(page);
  }
}

async function init() {
  try {
    info = await request('info'); token = info.token;
    const onCameraError = message => toast(message, true);
    cameraPreview = info.studio ? createMediaPreview({ onError: onCameraError })
      : createCameraPreview({ request, headers: requestHeaders, onError: onCameraError });
    initializeModelPlacement();
    updateCameraPreview();
    applyMode();
    servoPanel.reset(info.joints); actionEditor.render();
    if (info.studio) await selectWorkspace('control'); else await renewControl();
    poll();
    if (!info.readonly && !info.studio) actionEditor.refreshGroups().catch(error => toast(error.message, true));
  } catch (e) { console.error('控制台初始化失败', e); connectionError = e.message; renderTof(); setConnectionStatus('服务不可用', 'error', connectionError); toast(e.message, true); setTimeout(init, 3000); }
}
init();
