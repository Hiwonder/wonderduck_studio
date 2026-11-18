// Sidebar state and notifications shared by all workspaces.
import { friendlyErrorMessage } from './user-messages.js';

export function createConnectionStatus($) {
  return function setConnectionStatus(text, kind, detail = '') {
    const connection = $('connection'), device = $('device-connection'), dot = $('status-dot');
    if (connection.textContent !== text) connection.textContent = text;
    if (connection.title !== detail) connection.title = detail;
    const title = detail ? `${text}：${detail}` : text;
    if (device.title !== title) device.title = title;
    if (device.getAttribute('aria-label') !== text) device.setAttribute('aria-label', text);
    const dotClass = `dot ${kind}`;
    if (dot.className !== dotClass) dot.className = dotClass;
  };
}

export function lowVoltageWarning(status) {
  if (Number.isFinite(status?.voltage_v) && Number.isFinite(status?.settings?.threshold_v)
      && status.voltage_v >= status.settings.threshold_v) return false;
  return status?.triggered === true || (Number.isFinite(status?.voltage_v)
    && Number.isFinite(status?.settings?.threshold_v) && status.voltage_v < status.settings.threshold_v
    && Number.isFinite(status?.low_for_ms) && status.low_for_ms >= 1000);
}

// When the device-status page owns the bus, the control loop's voltage monitor is
// paused. Use that page's fresh, individually sampled servo voltages for the display.
export function createLowVoltageIndicator() {
  let lowSince = null;
  return (status, voltages, now) => {
    if (status?.triggered || Number.isFinite(status?.voltage_v)) {
      lowSince = null;
      return status;
    }
    const threshold = status?.settings?.threshold_v;
    const valid = voltages.filter(value => Number.isFinite(value) && value > 0);
    const voltage = valid.length ? Math.min(...valid) : null;
    if (!Number.isFinite(threshold) || voltage === null || voltage >= threshold) {
      lowSince = null;
      return status;
    }
    if (lowSince === null || now < lowSince) lowSince = now;
    return { ...status, voltage_v: voltage, low_for_ms: now - lowSince, display_only: true };
  };
}

export function renderSidebarVoltage($, { calibrating, voltage, fresh, lowVoltage }) {
  calibrating = Boolean(calibrating);
  const warning = lowVoltageWarning(lowVoltage);
  const output = $('sidebar-voltage');
  const shownVoltage = warning && Number.isFinite(lowVoltage.voltage_v) ? lowVoltage.voltage_v : voltage;
  const text = calibrating ? '采集中' : (fresh || warning) && Number.isFinite(shownVoltage) ? `${shownVoltage.toFixed(1)} V` : '--';
  const label = warning ? '电压过低，请及时充电' : calibrating ? 'IMU 校准采集中' : '电池电压';
  if (output.textContent !== text) output.textContent = text;
  if (output.getAttribute('aria-label') !== label) output.setAttribute('aria-label', label);
  const row = $('sidebar-telemetry'), battery = $('sidebar-battery-icon'), sampling = $('sidebar-sampling-icon');
  if (row.title !== label) row.title = label;
  row.classList.toggle('low-voltage', warning);
  if (battery.hasAttribute('hidden') !== calibrating) battery.toggleAttribute('hidden', calibrating);
  if (sampling.hasAttribute('hidden') === calibrating) sampling.toggleAttribute('hidden', !calibrating);
}

export function createSidebar($, iconsRefresh) {
  const compactSidebar = window.matchMedia('(max-width:720px)');
  let sidebarOpen = null;
  function setSidebarOpen(open) {
    if (sidebarOpen === open) return;
    sidebarOpen = open;
    document.body.classList.toggle('sidebar-open', open);
    document.body.classList.toggle('sidebar-collapsed', !open);
    $('sidebar-scrim').hidden = !(open && compactSidebar.matches);
    $('sidebar-toggle').setAttribute('aria-expanded', String(open));
    const label = open ? '收起侧边栏' : '展开侧边栏';
    $('sidebar-toggle').title = label;
    $('sidebar-toggle').setAttribute('aria-label', label);
    $('sidebar-toggle').innerHTML = `<i data-lucide="${open ? 'panel-left-close' : 'menu'}"></i><span>${open ? '收起' : '展开'}</span>`;
    iconsRefresh();
  }
  $('sidebar-toggle').addEventListener('click', () => setSidebarOpen(!document.body.classList.contains('sidebar-open')));
  $('sidebar-scrim').addEventListener('click', () => setSidebarOpen(false));
  document.addEventListener('keydown', event => { if (event.key === 'Escape' && compactSidebar.matches) setSidebarOpen(false); });
  compactSidebar.addEventListener('change', event => setSidebarOpen(!event.matches));
  setSidebarOpen(!compactSidebar.matches);
  return setSidebarOpen;
}

export function createNotifications($) {
  const lastCommand = $('last-command');
  let lastStatus = lastCommand.textContent, noticeId = 0;
  function toast(message, error = false, { routine = false } = {}) {
    if (message === '工作区已切换，请重新操作') return;
    if (error) message = friendlyErrorMessage(message);
    if (routine) {
      lastStatus = message;
      if (lastCommand.textContent !== message) lastCommand.textContent = message;
      if (lastCommand.classList.contains('error') !== error) lastCommand.classList.toggle('error', error);
      return;
    }
    $('toast-message').textContent = message;
    $('toast').classList.toggle('error', error);
    $('toast').hidden = false;
    clearTimeout(toast.timer);
    const current = ++noticeId;
    toast.timer = setTimeout(() => { $('toast').hidden = true; }, error ? 7000 : 3000);
    return current;
  }
  toast.dismiss = id => {
    if (id !== noticeId) return;
    clearTimeout(toast.timer);
    $('toast').hidden = true;
  };
  $('toast-close').addEventListener('click', () => toast.dismiss(noticeId));
  new MutationObserver(() => {
    if (lastCommand.textContent === lastStatus) return;
    lastStatus = lastCommand.textContent;
    lastCommand.classList.remove('error');
  }).observe(lastCommand, { childList: true, characterData: true, subtree: true });
  return toast;
}
