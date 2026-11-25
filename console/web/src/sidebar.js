// Sidebar state shared by all workspaces.
import { deviceFresh, SAMPLE_MAX_AGE_MS, SERVO_STATUS_MAX_AGE_MS } from './state-status.js';
import { setLocalizedAttribute, setLocalizedText } from '../../../webpadd/web/language.js';

export function createConnectionStatus($) {
  return function setConnectionStatus(text, kind, detail = '') {
    const connection = $('connection'), device = $('device-connection'), dot = $('status-dot');
    setLocalizedText(connection, text);
    setLocalizedAttribute(connection, 'title', detail);
    const title = detail ? `${text}：${detail}` : text;
    setLocalizedAttribute(device, 'title', title);
    setLocalizedAttribute(device, 'aria-label', text);
    const dotClass = `dot ${kind}`;
    if (dot.className !== dotClass) dot.className = dotClass;
  };
}

export function lowVoltageWarning(status) {
  if (typeof status?.warning_active === 'boolean') return status.warning_active;
  if (Number.isFinite(status?.voltage_v) && Number.isFinite(status?.settings?.threshold_v)
      && status.voltage_v >= status.settings.threshold_v) return false;
  return status?.triggered === true || (Number.isFinite(status?.voltage_v)
    && Number.isFinite(status?.settings?.threshold_v) && status.voltage_v < status.settings.threshold_v
    && Number.isFinite(status?.low_for_ms) && status.low_for_ms >= 1000);
}

// Estimate display voltage from existing servo observations only. This does
// not initiate a bus read and is never used by the protection monitor.
export function estimateServoVoltage(state, elapsed = 0, connectionError = '') {
  if (state?.device_paused || !Array.isArray(state?.servos)) return null;
  const maxAge = state.individual_device_scan || Number.isFinite(state.device_report_age_ms)
    ? SERVO_STATUS_MAX_AGE_MS : SAMPLE_MAX_AGE_MS;
  const servos = state.servos.filter(servo => !servo?.discovered);
  const values = servos.filter(servo => deviceFresh(servo, state, elapsed, connectionError, maxAge)
      && servo.online !== false && !servo.error && !(servo.faults?.length)
      && (!Number.isInteger(servo.status) || servo.status === 0)
      && Number.isFinite(servo.voltage) && servo.voltage > 0)
    .map(servo => servo.voltage).sort((a, b) => a - b);
  if (!values.length) return null;
  const middle = Math.floor(values.length / 2);
  const median = values.length % 2 ? values[middle] : (values[middle - 1] + values[middle]) / 2;
  const tolerance = Math.max(1, median * 0.15);
  const agreeing = values.filter(value => Math.abs(value - median) <= tolerance);
  // Without a majority, the remaining readings do not identify a reliable value.
  if (!agreeing.length || (values.length >= 3 && agreeing.length < Math.ceil(values.length / 2))) return null;
  return {
    voltage: agreeing.reduce((sum, value) => sum + value, 0) / agreeing.length,
    excluded: agreeing.length !== servos.length,
  };
}

export function displayVoltage(state, elapsed = 0, connectionError = '') {
  const estimate = estimateServoVoltage(state, elapsed, connectionError);
  const healthVoltage = state?.robot?.health?.battery?.volts;
  const independent = state?.individual_device_scan || Number.isFinite(state?.device_report_age_ms);
  if (independent && !estimate) return null;
  if (estimate && (estimate.excluded || state.individual_device_scan || Number.isFinite(state.device_report_age_ms)
      || !Number.isFinite(healthVoltage) || healthVoltage <= 0)) return estimate.voltage;
  return Number.isFinite(healthVoltage) && healthVoltage > 0 ? healthVoltage : null;
}

// When the device-status page owns the bus, the control loop's voltage monitor is
// paused. Use that page's fresh, individually sampled servo voltages for the display.
export function createLowVoltageIndicator() {
  let lowSince = null;
  return (status, voltages, now) => {
    if (typeof status?.warning_active === 'boolean' || status?.triggered || Number.isFinite(status?.voltage_v)) {
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

export function renderTopbarVoltage($, { calibrating, voltage, fresh, lowVoltage, warning }) {
  calibrating = Boolean(calibrating) && !warning;
  const output = $('topbar-voltage');
  const shownVoltage = warning && Number.isFinite(lowVoltage?.voltage_v) ? lowVoltage.voltage_v : voltage;
  const text = calibrating ? '采集中' : (fresh || warning) && Number.isFinite(shownVoltage) ? `${shownVoltage.toFixed(1)} V` : '--';
  const label = warning ? '电压过低，请及时充电' : calibrating ? 'IMU 校准采集中' : '电池电压';
  setLocalizedText(output, text);
  setLocalizedAttribute(output, 'aria-label', label);
  const row = $('topbar-battery');
  setLocalizedAttribute(row, 'title', label);
  row.classList.toggle('low-voltage', warning);
  $('topbar-battery-icon').toggleAttribute('hidden', calibrating || warning);
  $('topbar-battery-low-icon').toggleAttribute('hidden', !warning);
  $('topbar-sampling-icon').toggleAttribute('hidden', !calibrating);
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
