import { deviceFresh, SERVO_STATUS_MAX_AGE_MS, servoStatus } from './state-status.js';
import { lowVoltageWarning } from './sidebar.js';

// Keep these targets aligned with robotd's HX startup configuration. PID is
// displayed as P / I / D, unlike the servo's register order P / D / I.
const STARTUP_POSITION_PID = [15, 0, 0];
const STARTUP_TEMPERATURE_LIMIT = 120;
const STARTUP_MINIMUM_TORQUE = 0;

export function startupConfigurationMismatch(id, configuration) {
  const pid = configuration?.position_pid;
  const validPid = Array.isArray(pid) && pid.length === 3 && pid.every(Number.isInteger);
  return {
    pid: validPid && pid.some((value, index) => value !== STARTUP_POSITION_PID[index]),
    temperature: id !== 34 && Number.isInteger(configuration?.overtemperature_c)
      && configuration.overtemperature_c !== STARTUP_TEMPERATURE_LIMIT,
    torque: id !== 34 && Number.isInteger(configuration?.minimum_starting_torque)
      && configuration.minimum_starting_torque !== STARTUP_MINIMUM_TORQUE,
  };
}

export function formatResourceUsage(usage) {
  const used = usage?.used_bytes, total = usage?.total_bytes;
  if (!Number.isFinite(used) || !Number.isFinite(total) || used < 0 || total <= 0 || used > total) return '--';
  const gib = 1024 ** 3, mib = 1024 ** 2;
  return total >= gib ? `${(used / gib).toFixed(1)} / ${(total / gib).toFixed(1)} GiB`
    : `${Math.round(used / mib)} / ${Math.round(total / mib)} MiB`;
}

export function createDeviceStatus({ toast }) {
  const get = id => document.getElementById(id);
  const rows = new Map();
  let lastStatusNotice = '', lastAuxNotice = '';
  const number = (value, digits, suffix = '') => Number.isFinite(value) ? `${value.toFixed(digits)}${suffix}` : '--';
  const vector = (values, digits = 3) => Array.isArray(values) && values.length === 3 && values.every(Number.isFinite)
    ? values.map(value => value.toFixed(digits)).join('  /  ') : '--';
  const reading = (id, value) => {
    const element = get(id);
    if (element.textContent !== value) element.textContent = value;
    element.title = value;
  };
  const setText = (id, value) => {
    const element = get(id);
    if (element.textContent !== value) element.textContent = value;
  };

  function rebuild(joints) {
    rows.clear();
    const body = get('status-servo-rows');
    body.replaceChildren();
    for (const joint of joints) {
      const row = document.createElement('tr');
      const name = document.createElement('td');
      const id = document.createElement('span');
      id.className = 'status-id';
      id.textContent = joint.id;
      name.append(id, document.createTextNode(joint.label || joint.name));
      row.append(name);
      const cells = Array.from({ length: 11 }, () => document.createElement('td'));
      row.append(...cells);
      body.append(row);
      rows.set(joint.id, { cells, row });
    }
  }

  function render(info, state, fresh, elapsed, connectionError, auxiliary, handoff = false,
                  lowVoltage = state.robot?.low_voltage) {
    const joints = info?.joints || [];
    if (rows.size !== joints.length || joints.some(joint => !rows.has(joint.id))) rebuild(joints);
    const imu = state.imu || {};
    const valid = deviceFresh(imu, state, elapsed, connectionError);
    if (info?.studio) {
      const health = state.robot?.health || {}, safety = state.safety || {};
      const motor = health.motors;
      const motorId = joints.find(joint => joint.name === motor?.hottest)?.id;
      const motorTemperature = number(motor?.max_c, 0, ' °C');
      const warning = lowVoltageWarning(lowVoltage);
      const voltage = warning && Number.isFinite(lowVoltage.voltage_v) ? lowVoltage.voltage_v : health.battery?.volts;
      setText('runtime-battery', number(voltage, 1, ' V'));
      get('runtime-battery').classList.toggle('low-voltage', warning);
      get('runtime-battery').title = warning ? '电压过低，请及时充电' : '电池电压';
      setText('runtime-motor', motorTemperature !== '--' && Number.isInteger(motorId)
        ? `${motorTemperature} · ID ${motorId}` : motorTemperature);
      get('runtime-motor').title = motor?.hottest || '';
      setText('runtime-cpu', number(health.cpu_temp_c, 0, ' °C'));
      setText('runtime-safety', !fresh ? '--' : safety.fallen ? '摔倒' : safety.limp ? '卸力状态' : '正常');
    }
    const deviceReportsFresh = Number.isFinite(state.device_report_age_ms) &&
      state.device_report_age_ms + Math.max(0, elapsed) < SERVO_STATUS_MAX_AGE_MS;
    const statusNotice = state.device_paused ? '维护占用，独立采集暂停'
      : state.calibration?.active ? '标定中 · 常规采集暂停'
      : connectionError ? '连接中断'
      : state.bus_waiting || (state.online === false && state.error) ||
        (fresh || deviceReportsFresh ? '' : '数据不可用');
    const transientHandoff = handoff && !connectionError && !state.error &&
      ((state.online && !fresh) || (state.online === false && state.sequence == null && !state.calibration?.active));
    if (!transientHandoff && statusNotice !== lastStatusNotice) {
      lastStatusNotice = statusNotice;
      if (statusNotice) toast(statusNotice, statusNotice !== '标定中 · 常规采集暂停');
    }
    reading('status-gyro', valid ? vector(imu.gyro_rad_s) : '--');
    reading('status-gravity', valid ? vector(imu.gravity) : '--');
    reading('status-quaternion', valid && Array.isArray(imu.quaternion_wxyz) && imu.quaternion_wxyz.every(Number.isFinite)
      ? imu.quaternion_wxyz.map(value => value.toFixed(3)).join('  /  ') : '--');
    const aux = state.aux_imu || {};
    for (const [index, axis] of ['roll', 'pitch', 'yaw'].entries()) {
      setText(`aux-curve-${axis}`, auxiliary.valid ? `${aux.rpy_deg[index].toFixed(1)}°` : '--');
    }
    reading('aux-gyro', auxiliary.valid ? vector(aux.gyro_rad_s) : '--');
    reading('aux-gravity', auxiliary.valid ? vector(aux.gravity) : '--');
    reading('aux-quaternion', auxiliary.valid ? aux.quaternion_wxyz.map(value => value.toFixed(3)).join('  /  ') : '--');
    const auxNotice = auxiliary.valid ? '' : auxiliary.detail !== auxiliary.label
      ? `${auxiliary.label}：${auxiliary.detail}` : auxiliary.label;
    const transientAux = transientHandoff && ['starting', 'waiting', 'stale'].includes(auxiliary.kind);
    if (!transientAux && auxNotice !== lastAuxNotice) {
      lastAuxNotice = auxNotice;
      if (auxNotice) toast(`头部 IMU：${auxNotice}`, !['starting', 'waiting'].includes(auxiliary.kind));
    }
    get('aux-imu-caption').hidden = !auxiliary.valid;
    const servos = new Map((state.servos || []).map(servo => [servo.id, servo]));
    const statuses = new Map();
    for (const joint of joints) {
      const servo = servos.get(joint.id);
      const status = servoStatus(servo, state, elapsed, connectionError, SERVO_STATUS_MAX_AGE_MS);
      const config = servo?.configuration;
      const mismatch = status.valid && !servo?.configuration_error && !state.calibration?.active
        ? startupConfigurationMismatch(joint.id, config) : { pid: false, temperature: false, torque: false };
      const hasMismatch = mismatch.pid || mismatch.temperature || mismatch.torque;
      statuses.set(joint.id, state.calibration?.active ? 'paused'
        : status.kind === 'normal' && hasMismatch ? 'configuration' : status.kind);
      const version = values => Array.isArray(values) && values.length === 2 && values.every(Number.isInteger)
        ? values.join('.') : '--';
      const values = [status.valid ? number(servo.raw, 0) : '--', status.valid ? number(servo.degrees, 1, '°') : '--',
        status.valid ? number(servo.speed_rad_s, 2, ' rad/s') : '--',
        status.valid ? number(servo.load_percent, 1, '%') : '--',
        status.valid ? number(servo.voltage, 1, ' V') : '--',
        status.valid ? number(servo.temperature, 0, ' °C') : '--',
        state.calibration?.active ? '标定中' : status.label,
        Array.isArray(config?.position_pid) ? config.position_pid.join(' / ') : '--',
        number(config?.overtemperature_c, 0, ' °C'), number(config?.minimum_starting_torque, 0),
        config ? `${version(config.firmware_version)} / ${version(config.servo_version)}` : '--'];
      const entry = rows.get(joint.id);
      entry.cells.forEach((cell, index) => {
        if (cell.textContent !== values[index]) cell.textContent = values[index];
        cell.title = index >= 7 && servo?.configuration_error ? servo.configuration_error : values[index];
      });
      entry.cells[6].className = status.kind === 'normal' && !state.calibration?.active ? '' : 'status-error';
      for (const [index, differs, expected] of [
        [7, mismatch.pid, '开机设置：15 / 0 / 0'],
        [8, mismatch.temperature, '开机设置：120 °C'],
        [9, mismatch.torque, '开机设置：0'],
      ]) {
        entry.cells[index].classList.toggle('status-error', differs);
        if (differs) entry.cells[index].title = `${values[index]}；${expected}`;
      }
      entry.row.title = status.title;
    }
    return statuses;
  }
  function renderResources(resources) {
    setText('runtime-storage', formatResourceUsage(resources?.storage));
    setText('runtime-memory', formatResourceUsage(resources?.memory));
  }
  return { render, renderResources };
}
