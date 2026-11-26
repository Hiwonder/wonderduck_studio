import { createIcons, Bot, Power, PowerOff, Menu, PanelLeftClose, Crosshair, Play, SlidersHorizontal, LayoutGrid, RotateCcw, Undo2,
  Lock, LockOpen, Plus, Minus, ListPlus, RefreshCw, Download, Trash2, ArrowUp, ArrowDown, ChevronUp, ChevronDown, ChevronLeft, ChevronRight,
  FlipHorizontal2, FolderOpen, Files, Save, Square, House, Activity, Gauge, Gamepad2, Eye, EyeOff, HandHelping, Footprints, UserRoundSearch, Radar, Settings, Wrench, Wifi, Radio, Battery, BatteryLow, Languages } from 'lucide';
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
import { createDeviceStatus } from './device-status.js';
import { createConnectionStatus, createLowVoltageIndicator, createSidebar, displayVoltage, lowVoltageWarning, renderTopbarVoltage } from './sidebar.js';
import { createNotifications } from './notifications.js';
import { createServoPanel } from './servo-panel.js';
import { createServoDebugMode } from './servo-debug-mode.js';
import { createActionEditor } from './action-editor.js';
import { createCameraPreview } from './camera-preview.js';
import { createMediaPreview } from './media-preview.js';
import { createNetworkControls } from './network.js';
import { createModelControls } from './models.js';
import { createWorkspaceVisuals } from './workspace-visuals.js';
import { createReleaseConfirmation } from './release-confirm.js';
import { createWorkspaceController, isControlWorkspace } from './workspace-controller.js';
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
const headImuEnabled = () => info?.head_imu_enabled !== false;
let token = '', lastImuKey = '', lastGood = 0, responseSequence = 0, lastAuxSequence = -1;
let auxValid = false;
let lowVoltageActive = false;
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
  if (!headImuEnabled()) return;
  headSubscriptionRevision++;
  sessionStorage.setItem('head-subscription-revision', String(headSubscriptionRevision));
}
const samples = [], auxSamples = [];
const fmt = (n, digits = 1) => Number.isFinite(n) ? n.toFixed(digits) : '--';
const iconsRefresh = () => {
  createIcons({ icons: { Bot, Power, PowerOff, Menu, PanelLeftClose, Crosshair, Play,
    SlidersHorizontal, LayoutGrid, RotateCcw, Undo2, Lock, LockOpen, Plus, Minus, ListPlus, RefreshCw, Download, Trash2, ArrowUp, ArrowDown, ChevronUp, ChevronDown, ChevronLeft, ChevronRight,
    FlipHorizontal2, FolderOpen, Files, Save, Square, House, Activity, Gauge, Gamepad2, Eye, EyeOff, HandHelping, Footprints, UserRoundSearch, Radar, Settings, Wrench, Wifi, Radio, Battery, BatteryLow, Languages }, attrs: { 'stroke-width': 1.8 } });
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
const toast = createNotifications($('toast'));
const workspaceToast = workspace => (message, error, options) => {
  if (document.body.dataset.workspace === workspace) return toast(message, error, { ...options, workspace });
};
const actionToast = workspaceToast('action');
const statusToast = workspaceToast('status');
let displayedWorkspace;
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
  'X-Studio-Workspace': workspaces.current,
  ...(headImuEnabled() ? { 'X-Head-Subscription-Revision': String(headSubscriptionRevision) } : {}),
  ...(headImuEnabled() && workspaces.current === 'calibration' ? { 'X-Calibration-Source': workspaceVisuals.calibrationSource() } : {}) });
let cameraPreview;
function updateCameraPreview(page = workspaces.current) {
  const available = page === 'status';
  $('camera-enabled').closest('label').hidden = !available;
  const enabled = available && $('camera-enabled').checked;
  $('camera-preview').hidden = !enabled;
  if (!cameraPreview) return;
  if (enabled && info) cameraPreview.start();
  else {
    cameraPreview.stop();
    toast.clearSource('camera-status', 'status');
  }
}
$('camera-enabled').addEventListener('change', () => updateCameraPreview());

async function request(path, body, timeoutMs = null, signal = null) {
  const headers = requestHeaders();
  if (path === 'state' && document.hidden && workspaces.current === 'status') headers['X-Studio-Workspace'] = '';
  const timeout = AbortSignal.timeout(timeoutMs ?? (path === 'workspace' && body?.rest_before ? 150000 : path === 'workspace' || path === 'emergency-release' || body?.action === 'servo_debug' || path === 'control-actions' && body?.operation !== 'list' ? 60000 : path.startsWith('models/online') && body ? 30000 : path === 'network/scan' ? 20000 : path === 'camera/offer' ? 14000 : 6500));
  const response = await fetch(`/api/${path}`, {
    method: body ? 'POST' : 'GET',
    headers,
    body: body ? JSON.stringify(body) : undefined,
    signal: signal ? AbortSignal.any([timeout, signal]) : timeout,
    cache: 'no-store',
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
  if (!info || info.readonly || sidebarReleaseBusy || (info.studio && (workspaces.current !== 'action' || !workspaces.ready)) || document.hidden || workspaces.busy || controlPending || performance.now() < nextControlAttempt) return;
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

const workspaceVisuals = createWorkspaceVisuals({
  request, confirmAction, toast: workspaceToast('calibration'),
  context: () => ({
    info, state, connectionError, elapsed: sampleElapsed(), selected, joints: info?.joints || [],
    cameraExpanded: cameraPreview?.expanded,
    imuIsFresh: () => imuFresh(state?.imu, state, sampleElapsed(), connectionError),
    servoIsFresh: liveServoFresh,
  }),
  onCalibrationSourceChange() {
    advanceHeadSubscription();
    if (info?.studio && workspaces.current === 'calibration' && token) {
      request('state').catch(error => console.debug('头部 IMU 采集切换失败', error.message));
    }
  },
});

const servoPanel = createServoPanel({
  request, toast: actionToast, iconsRefresh, confirmRelease,
  context: () => ({ info, state, armed, fresh: stateFresh(), elapsed: sampleElapsed(), connectionError,
    active: !info?.studio || (workspaces.current === 'action' && workspaces.ready) }),
  select: ids => { selected = ids; highlightSelectedJoints(); },
  onPose: workspaceVisuals.alignPoseToPlatform,
});
const actionEditor = createActionEditor({ request, toast: actionToast, confirmAction, iconsRefresh, servoPanel,
  context: () => ({ info, state, armed, fresh: stateFresh(), connectionError }) });
setInterval(renewControl, 1000);

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

const deviceStatus = createDeviceStatus({ toast });
const networkControls = createNetworkControls({ request, confirmAction, iconsRefresh, toast: workspaceToast('network') });
const modelControls = createModelControls({ request, requestHeaders, refreshSession, confirmAction, toast: workspaceToast('models'),
  supportsUpdates: () => !!info?.supports_model_update_resume,
  supportsOnline: () => !!info?.supports_model_update_resume && !!info?.supports_online_models
    && !!info?.supports_online_model_rest && !!info?.supports_model_version_gate });
let sidebarTransitionPending = false;
let sidebarTransitionCompleted = 0;
const waitingForFirstSample = value => value?.online === false && value.sequence == null
  && !value.error && !value.calibration?.active;
let controlActionActive = false, controlActionStarting = false, controlActionPollBusy = false;
let controlActionTimer = null;
let controlActionGeneration = 0, controlActionRunId = null, controlActionPageHidden = false;
let controlActionStartSent = false, controlActionSettled = Promise.resolve();
servoDebugMode = createServoDebugMode({ request, toast: actionToast, confirmAction,
  context: () => ({ info, state, armed, workspace: workspaces.current, switchingWorkspace: workspaces.busy,
    ready: !info?.studio || workspaces.ready }) });
const servoToolbar = document.querySelector('.servo-section .section-bar');
const actionHeading = document.querySelector('.action-heading');
const actionAlignment = new ResizeObserver(() => $('action-editor').style.setProperty('--action-top-offset',
  `${Math.max(0, servoToolbar.offsetHeight - actionHeading.offsetHeight)}px`));
actionAlignment.observe(servoToolbar);
actionAlignment.observe(actionHeading);

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
  if (resume && workspaces.current === 'control') workspaces.resumeControl();
}

async function stopControlAction(resume = true) {
  const result = await request('control-actions', { operation: 'stop', run_id: controlActionRunId });
  if (!result.active) finishControlAction(result, resume);
  return result;
}

function pollControlAction() {
  if (!controlActionActive || controlActionPollBusy || workspaces.busy) return;
  controlActionPollBusy = true;
  request('control-actions', { operation: 'status', run_id: controlActionRunId }).then(result => {
    if (!controlActionActive) return;
    if (result.active) notifyControlAction(result);
    else finishControlAction(result);
  }).catch(error => toast(`动作状态读取失败：${error.message}`, true))
    .finally(() => { controlActionPollBusy = false; });
}

async function audioToggleSetting(event, setting) {
  const { requestId, enabled } = event.data;
  if (!Number.isSafeInteger(requestId)) return;
  const reply = data => event.source.postMessage({ type: `studio-${setting}-result`, requestId, ...data }, event.origin);
  try {
    if (workspaces.current !== 'system') throw new Error('请先打开系统设置');
    if (enabled !== undefined && typeof enabled !== 'boolean') throw new Error('设置无效');
    const result = await request(setting, enabled === undefined ? undefined : { enabled });
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
  rest: '正在等待机器人休息并锁定控制',
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
  if (workspaces.current !== 'system' || workspaces.busy || softwareUpdateBusy || !info?.supports_software_update) return;
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
    if (workspaces.current !== 'system' || workspaces.busy) return;
    if (!await confirmAction('软件更新', '发现新版本 ' + version + '，是否更新？')) return;
    if (workspaces.current !== 'system' || workspaces.busy) return;
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
    if (!Number.isSafeInteger(requestId) || workspaces.current !== 'control' || workspaces.busy || controlActionPageHidden) {
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
        await workspaces.leaveControl();
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
        if (leaveAttempted && generation === controlActionGeneration && workspaces.current === 'control') {
          workspaces.resumeControl();
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
    if (!await confirmAction('重启服务', '机器人会先休息，再重启服务。确定重启吗？')) return;
    if (!info?.supports_service_restart) return;
    const previousToken = token;
    toast('正在等待机器人休息', false, { source: 'service-restart' });
    const result = await request('service/restart', {}, 160000);
    toast.clearSource('service-restart');
    toast(result.rest_warning
      ? `休息未完成，继续重启服务：${result.rest_warning}`
      : '服务正在重启，恢复后页面将自动刷新');
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
    toast.clearSource('service-restart');
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
    if (workspaces.current === 'control' && !workspaces.busy && !controlActionPageHidden) {
      workspaces.resumeControl();
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
  const page = document.body.dataset.workspace;
  if (page === 'debug' && event.origin === location.origin && event.source === debug.contentWindow) {
    if (event.data?.type === 'studio-servo-selected' && Number.isInteger(event.data.id)) {
      selected = [event.data.id];
      highlightSelectedJoints();
    } else if (event.data?.type === 'studio-debug-size' && Number.isFinite(event.data.height)
        && window.matchMedia('(max-width:999px)').matches) {
      debug.style.setProperty('--debug-frame-content-height', `${Math.ceil(event.data.height)}px`);
    } else if (event.data?.type === 'studio-feedback' && typeof event.data.text === 'string' && typeof event.data.error === 'boolean') {
      toast(event.data.text, event.data.error, { routine: event.data.routine === true,
        source: typeof event.data.source === 'string' ? event.data.source : null, workspace: 'debug' });
    }
  } else if (!control.hidden && isControlWorkspace(page) && workspaces.current === page && control.src && control.src !== 'about:blank'
      && event.source === control.contentWindow && event.origin === new URL(control.src).origin) {
    if (event.data?.type === 'studio-feedback' && typeof event.data.text === 'string' && typeof event.data.error === 'boolean') {
      if (event.data.page !== page) return;
      toast(event.data.text, event.data.error, { routine: event.data.routine === true,
        source: typeof event.data.source === 'string' ? event.data.source : null, workspace: page });
    } else if (event.data?.type === 'studio-feedback-clear' && typeof event.data.source === 'string') {
      if (event.data.page === page) toast.clearSource(event.data.source, page);
    } else if (event.data?.type === 'studio-action-request') {
      controlAction(event);
    } else if (event.data?.type === 'studio-network-announcement-request') {
      audioToggleSetting(event, 'network-announcement');
    } else if (event.data?.type === 'studio-mouth-audio-request') {
      audioToggleSetting(event, 'mouth-audio');
    } else if (event.data?.type === 'studio-software-update-request') {
      checkSoftwareUpdate();
    }
  }
});

window.addEventListener('pageshow', () => { controlActionPageHidden = false; });
window.addEventListener('pagehide', () => {
  controlActionPageHidden = true;
  controlActionGeneration++;
  if ((controlActionActive || controlActionStarting) && controlActionRunId && token) {
    fetch('/api/control-actions', { method: 'POST', headers: requestHeaders(),
      body: JSON.stringify({ operation: 'stop', run_id: controlActionRunId }), keepalive: true })
      .catch(error => console.debug('动作停止请求未送达', error.message));
  }

});

const workspaces = createWorkspaceController({
  $, request, requestHeaders,
  session: () => ({ ...info, token }),
  refreshInfo: async signal => {
    const updated = await request('info', undefined, null, signal);
    signal.throwIfAborted();
    info = updated;
    token = updated.token;
  },
  revise: advanceHeadSubscription,
  toast,
  onDisarm(release) {
    if (release) return releaseControl();
    controlGeneration++;
    setArmed(false);
  },
  waitForLocalWork: () => servoDebugMode.busy() || controlActionStarting,
  onTransition(starting, restoring) {
    if (!restoring) {
      if (starting) sidebarTransitionPending = !!state && state.online && stateFresh();
      else if (sidebarTransitionPending) sidebarTransitionCompleted = performance.now();
    }
    servoDebugMode.update();
  },
  async beforeLeave(previous, next, wasReady) {
    if (previous === next) return;
    if (previous === 'calibration') workspaceVisuals.setCalibrationActive(false);
    if (previous === 'control' && controlActionActive) {
      try { await stopControlAction(false); } catch (error) { console.warn('停止动作时切换页面', error); }
    }
    if (previous === 'action') {
      try { await servoDebugMode.closeOnLeave(); } catch (error) { console.warn('关闭舵机调试模式时切换页面', error); }
      if (info?.studio && wasReady) {
        await servoPanel.flushTarget();
        await releaseControl();
      }
    }
  },
  onPreview(page) {
    if (displayedWorkspace !== page) {
      if (displayedWorkspace) toast.clearWorkspace(displayedWorkspace);
      displayedWorkspace = page;
      if (page !== 'network') networkControls.setActive(false);
      if (page !== 'models') modelControls.setActive(false);
    }
    updateCameraPreview(page);
    if (info) workspaceVisuals.preview(page);
  },
  onSelection(previous, page) {
    if (previous === 'debug' && page !== 'debug') selected = [];
    highlightSelectedJoints();
  },
  onReady(page, restoring) {
    networkControls.setActive(page === 'network');
    modelControls.setActive(page === 'models');
    workspaceVisuals.setCalibrationActive(page === 'calibration');
    updateControls();
    if (restoring) {
      if (page === 'status') request('state').catch(error => console.debug('设备状态采集恢复失败', error.message));
    } else {
      if (page === 'action' && info?.studio && !info.readonly) {
        actionEditor.refreshGroups().catch(error => actionToast(error.message, true));
      }
      if (window.matchMedia('(max-width:720px)').matches) setSidebarOpen(false);
    }
    if (page === 'action') {
      servoPanel.reset(info.joints);
      actionEditor.render();
    }
    if (state && info && (page !== 'action' || state.workspace === 'action' || !info.studio)) renderState();
    drawChart();
  },
  onFailure(page, error, restoring) {
    networkControls.setActive(false);
    modelControls.setActive(false);
    workspaceVisuals.setCalibrationActive(false);
    if (restoring) toast('恢复当前工作区失败：' + error.message, true);
    if (state && info) renderState();
  },
  onSettled: renewControl,
  controlUrl() {
    const url = new URL(location.href);
    url.port = location.protocol === 'https:' ? '9444' : '8081';
    url.pathname = '/';
    url.search = '?studio=1&theme=' + (document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light')
      + '&debug=' + Number(sidebarDebugMode.checked) + '&lang=' + getLanguage();
    url.hash = '';
    return url.href;
  },
  syncFrame(page, entered = true) {
    notifyFrames('studio-theme', { theme: document.documentElement.dataset.theme });
    notifyFrames('studio-language', { language: getLanguage() });
    if (page === 'debug' && entered) notifyFrames('studio-workspace', { page });
    if (isControlWorkspace(page)) {
      syncDebugMode();
      notifyFrames('studio-device-versions', { versions: info?.device_versions || null,
        softwareUpdate: info?.supports_software_update, busy: softwareUpdateBusy });
    }
  },
});

function notifyFrames(type, data) {
  workspaces.notify(type, data);
}

function renderTof() {
  if (info?.tof_enabled === false) return;
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
  workspaceVisuals.updateCalibration();
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
  const transitionHandoff = workspaces.busy || (sidebarTransitionPending
    && performance.now() - sidebarTransitionCompleted < SAMPLE_MAX_AGE_MS);
  const playbackSamplingPaused = state.action_playback?.state === 'playing' && state.online && !state.error && !connectionError;
  const handoff = transitionHandoff || stateRequestPending || playbackSamplingPaused;
  const measuredVoltages = workspaces.current === 'status' && !state.device_paused
    ? state.servos.filter(servo => liveServoFresh(servo)).map(servo => servo.voltage)
    : [];
  deviceStatus.renderHealth(connectionError ? null : state.robot?.health);
  const lowVoltage = updateLowVoltage(state.robot?.low_voltage, measuredVoltages, performance.now());
  const voltageAlert = $('low-voltage-alert');
  if (!connectionError && lowVoltage) {
    const warning = lowVoltageWarning(lowVoltage);
    if (warning && !lowVoltageActive) voltageAlert.showModal();
    if (!warning && voltageAlert.open) voltageAlert.close();
    lowVoltageActive = warning;
  }
  renderTopbarVoltage($, {
    calibrating: state.calibration?.active || state.head_calibration?.active,
    voltage: displayVoltage(state, sampleElapsed(), connectionError),
    fresh: sidebarFresh,
    lowVoltage,
    warning: lowVoltageActive,
  });
  if (!(handoff && !connectionError && ((state.online && !fresh) || waitingForFirstSample(state)))) {
    const calibrating = !!state.calibration?.active || !!state.head_calibration?.active;
    const imuWorkspace = workspaces.current === 'calibration';
    const imuOnline = calibrating || valid || headImuEnabled() && auxImuStatus(state.aux_imu, sampleElapsed(), connectionError).valid;
    const connectionStatus = connectionError ? '连接中断' : imuWorkspace ? (imuOnline ? '设备在线' : '等待采样')
      : !sidebarState.online ? '采集异常' : !sidebarFresh ? '数据过期'
      : faults ? '舵机故障' : communication ? '总线通信异常' : timeout ? '舵机读取超时'
        : missing === info.joints.length ? '舵机未连接' : missing ? '部分舵机未连接'
        : invalid ? '舵机数据异常' : stale ? '设备数据过期'
          : (info.readonly ? 'robotd · 只读' : info.demo ? '演示连接' : '设备在线');
    setConnectionStatus(connectionStatus, !connectionError && (calibrating || sidebarFresh && !faults && !communication && !timeout && !missing && !invalid && !stale) ? 'live' : 'error',
      connectionError || sidebarState.error || '');
  }
  setText('pose-status', state.device_paused ? '维护占用' : state.calibration?.active ? '标定中'
    : state.imu_source === 'compare' ? (state.imu_comparison?.valid ? '双路有效' : '对比中')
      : valid ? '正常' : 'IMU 无效');
  $('pose-status').title = state.imu_source === 'compare'
    ? [state.imu_sources?.id200?.error, state.imu_sources?.i2c?.error].filter(Boolean).join('；')
    : state.imu?.error || state.error || '';
  const angles = valid ? quaternionAngles(state.imu.quaternion_wxyz) : [null, null, null];
  const heldAngles = !valid && state.imu?.valid && $('curve-roll').textContent !== '--';
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
  if (headImuEnabled() && !document.hidden && (workspaces.current === 'status' || workspaces.current === 'calibration' && workspaceVisuals.calibrationSource() === 'head') &&
      ['stale', 'pending'].includes(auxiliary.kind) && performance.now() - lastHeadDiagnostic >= 10000) {
    lastHeadDiagnostic = performance.now();
    console.warn('头部 IMU 过期诊断', { backend_status: state.aux_imu?.status, backend_age_ms: state.aux_imu?.age_ms,
      elapsed_ms: sampleElapsed(), poll_interval_ms: Math.round(statePollInterval),
      request_ms: Math.round(stateRequestDuration), render_ms: Math.round(stateRenderDuration),
      pending_request: stateRequestPending,
      pending_request_ms: stateRequestPending ? Math.round(performance.now() - stateRequestStarted) : null });
  }
  const auxChanged = auxValid !== auxiliary.valid;
  auxValid = auxiliary.valid;
  if (workspaces.current === 'status') {
    const statuses = deviceStatus.render(info, state, fresh, sampleElapsed(), connectionError, auxiliary, transitionHandoff, lowVoltage,
      displayVoltage(state, sampleElapsed(), connectionError));
    workspaceVisuals.updateStatuses(statuses);
  }
  if (workspaces.current === 'action' && (!info.studio || (state.workspace === 'action' && state.maintenance_owner))) {
    workspaceVisuals.updateReferenceTargets(state.pose_targets, info.joints);
  }
  updateControls();
  let chartChanged = auxChanged;
  const imuKey = `${state.imu?.t_ns ?? state.sequence}:${valid}`;
  if (imuKey !== lastImuKey) {
    samples.push({ time: performance.now(), angles: valid ? angles.map(angle => Number(angle.toFixed(1))) : null,
      maxGapMs: Number.isFinite(state.device_report_age_ms) ? INDEPENDENT_IMU_MAX_AGE_MS : 600 });
    lastImuKey = imuKey;
    while (samples.length && samples[0].time < performance.now() - 20000) samples.shift();
    chartChanged = true;
  }
  if (headImuEnabled() && responseSequence !== lastAuxSequence) {
    auxSamples.push({ time: performance.now(),
      angles: auxiliary.valid ? state.aux_imu.rpy_deg.map(value => Number(value.toFixed(1))) : null,
      reset_count: auxiliary.valid ? state.aux_imu.reset_count : null });
    lastAuxSequence = responseSequence;
    while (auxSamples.length && auxSamples[0].time < performance.now() - 20000) auxSamples.shift();
    chartChanged = true;
  }
  if (chartChanged) drawChart();
  workspaceVisuals.updatePose({
    quaternion: valid ? state.imu.quaternion_wxyz : null,
    servos: state.servos,
    fresh: fresh || deviceReportsFresh,
  });
}

async function poll() {
  const started = performance.now();
  const requestedWorkspace = workspaces.current;
  const requestedGeneration = controlGeneration;
  statePollInterval = previousStateStarted ? started - previousStateStarted : 0;
  previousStateStarted = started;
  if (headImuEnabled() && !document.hidden && (workspaces.current === 'status' || workspaces.current === 'calibration' && workspaceVisuals.calibrationSource() === 'head') &&
      statePollInterval > 500 && started - lastHeadDiagnostic >= 10000) {
    lastHeadDiagnostic = started;
    console.warn('头部 IMU 页面请求间断', { poll_interval_ms: Math.round(statePollInterval),
      previous_request_ms: Math.round(stateRequestDuration), previous_render_ms: Math.round(stateRenderDuration),
      backend_status: state?.aux_imu?.status, backend_age_ms: state?.aux_imu?.age_ms });
  }
  if (!document.hidden && !resourceRequestPending && started >= nextResourceRequest) {
    resourceRequestPending = true;
    nextResourceRequest = started + 5000;
    request('resources').then(data => deviceStatus.renderResources(data))
      .catch(() => deviceStatus.renderResources(null))
      .finally(() => { resourceRequestPending = false; });
  }
  stateRequestPending = true;
  stateRequestStarted = started;
  try {
    const snapshot = await request('state');
    stateRequestDuration = performance.now() - started;
    stateRequestPending = false;
    if (requestedWorkspace !== workspaces.current || requestedGeneration !== controlGeneration) return;
    state = snapshot;
    lastGood = performance.now();
    responseSequence++;
    connectionError = '';
    if (!workspaces.busy && (stateFresh() || (!state.online && !waitingForFirstSample(state)))) {
      sidebarTransitionPending = false;
    }
    if (armed && !state.armed && started > controlUpdatedAt) { setArmed(false); nextControlAttempt = 0; }
    if (!armed) renewControl();
    const renderStarted = performance.now();
    renderState();
    stateRenderDuration = performance.now() - renderStarted;
  } catch (e) {
    stateRequestPending = false;
    if (requestedWorkspace !== workspaces.current || requestedGeneration !== controlGeneration) return;
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
  if (headImuEnabled()) drawTrace($('aux-chart'), auxValid ? auxSamples : []);
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
const chartObserver = new ResizeObserver(drawChart);
chartObserver.observe($('chart'));
chartObserver.observe($('aux-chart'));
function highlightSelectedJoints() { workspaceVisuals.updateSelection(); }

function applyMode() {
  workspaceVisuals.updateCalibration();
  if (!info.readonly && !info.supports_direct_slider) toast('重启控制台服务后启用滑杆直接发送', true);
  updateSidebarRelease();
  updateSidebarShutdown();
  updateSidebarRestart();
  $('demo-badge').hidden = !info.demo;
  $('tof-reading').hidden = info.tof_enabled === false;
  const headChannel = $('head-imu-channel');
  headChannel.hidden = !headImuEnabled();
  headChannel.parentElement.classList.toggle('body-only', headChannel.hidden);
  $('calibration-source-row').hidden = headChannel.hidden;
  workspaceVisuals.setHeadAvailable(!headChannel.hidden);
  for (const element of document.querySelectorAll('.studio-only')) element.hidden = !info.studio;
  document.querySelector('[data-workspace="maze"]').hidden = !info.studio || info.tof_enabled === false;
  document.querySelector('[data-workspace="line"]').hidden = !info.studio || !info.workspaces?.includes('line');
}

async function init() {
  try {
    info = await request('info'); token = info.token;
    const onCameraError = message => statusToast(message, true, { source: 'camera-status' });
    cameraPreview = info.studio ? createMediaPreview({ onError: onCameraError })
      : createCameraPreview({ request, headers: requestHeaders, onError: onCameraError });
    updateCameraPreview();
    applyMode();
    servoPanel.reset(info.joints); actionEditor.render();
    if (info.studio) await workspaces.select('control');
    else {
      workspaceVisuals.preview(workspaces.current);
      await renewControl();
    }
    poll();
    if (!info.readonly && !info.studio) actionEditor.refreshGroups().catch(error => toast(error.message, true));
  } catch (e) { console.error('控制台初始化失败', e); connectionError = e.message; renderTof(); setConnectionStatus('服务不可用', 'error', connectionError); toast(e.message, true); setTimeout(init, 3000); }
}
init();
