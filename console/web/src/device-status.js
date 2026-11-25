import { deviceFresh, imuFresh, SAMPLE_MAX_AGE_MS, SERVO_STATUS_MAX_AGE_MS, servoStatus } from './state-status.js';
import { lowVoltageWarning } from './sidebar.js';
import { setLocalizedAttribute, setLocalizedText } from '../../../webpadd/web/language.js';

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

function usageFraction(used, total) {
  return Number.isFinite(used) && Number.isFinite(total) && used >= 0 && total > 0 && used <= total
    ? used / total : null;
}

export function hottestServoTemperature(state, elapsed = 0, connectionError = '') {
  if (state?.device_paused || !Array.isArray(state?.servos)) return null;
  const maxAge = state.individual_device_scan || Number.isFinite(state.device_report_age_ms)
    ? SERVO_STATUS_MAX_AGE_MS : SAMPLE_MAX_AGE_MS;
  let hottest = null;
  for (const servo of state.servos) {
    if (servo?.discovered || !deviceFresh(servo, state, elapsed, connectionError, maxAge)
        || servo.online === false || servo.error || !Number.isFinite(servo.temperature)
        || servo.temperature <= 0 || servo.temperature > 255) continue;
    // A reported fault does not invalidate a checksummed temperature. In
    // particular, keep an overheating servo in the maximum.
    if (!hottest || servo.temperature > hottest.temperature) {
      hottest = { id: servo.id, name: servo.label || servo.name || '', temperature: servo.temperature };
    }
  }
  return hottest;
}

export function createDeviceStatus({ toast }) {
  const get = id => document.getElementById(id);
  const rows = new Map();
  let lastStatusNotice = '', lastAuxNotice = '', resourceCpu = null, resourceCpuAt = 0, healthCpu = null;
  let previousCpu = null;
  const cpuTemperature = () => resourceCpu !== null && performance.now() - resourceCpuAt < 10000
    ? resourceCpu : healthCpu;
  const number = (value, digits, suffix = '') => Number.isFinite(value) ? `${value.toFixed(digits)}${suffix}` : '--';
  const vector = (values, digits = 3) => Array.isArray(values) && values.length === 3 && values.every(Number.isFinite)
    ? values.map(value => value.toFixed(digits)).join('  /  ') : '--';
  const reading = (id, value, historical = false) => {
    const element = get(id);
    setLocalizedText(element, value);
    element.classList.toggle('historical', historical && value !== '--');
    setLocalizedAttribute(element, 'title', historical && value !== '--' ? '数据过期' : value);
  };
  const setText = (id, value) => {
    const element = get(id);
    setLocalizedText(element, value);
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
                  lowVoltage = state.robot?.low_voltage, batteryVoltage = state.robot?.health?.battery?.volts) {
    const joints = info?.joints || [];
    if (rows.size !== joints.length || joints.some(joint => !rows.has(joint.id))) rebuild(joints);
    const imu = state.imu || {};
    const valid = imuFresh(imu, state, elapsed, connectionError);
    const historical = !valid && imu.valid && state.online && !state.device_paused &&
      !state.calibration?.active && !connectionError;
    const showImu = valid || historical;
    if (info?.studio) {
      const health = state.robot?.health || {}, safety = state.safety || {};
      const independent = state.individual_device_scan || Number.isFinite(state.device_report_age_ms);
      const observedMotor = hottestServoTemperature(state, elapsed, connectionError);
      const motor = independent ? observedMotor : observedMotor || (health.motors && {
        id: joints.find(joint => joint.name === health.motors.hottest)?.id,
        name: health.motors.hottest, temperature: health.motors.max_c,
      });
      const motorTemperature = number(motor?.temperature, 0, ' °C');
      const warning = lowVoltageWarning(lowVoltage);
      const voltage = warning && Number.isFinite(lowVoltage.voltage_v) ? lowVoltage.voltage_v : batteryVoltage;
      setText('runtime-battery', number(voltage, 1, ' V'));
      get('runtime-battery').classList.toggle('low-voltage', warning);
      get('runtime-battery').title = warning ? '电压过低，请及时充电' : '电池电压';
      setText('runtime-motor', motorTemperature !== '--' && Number.isInteger(motor?.id)
        ? `${motorTemperature} · ID ${motor.id}` : motorTemperature);
      get('runtime-motor').title = motor?.name || '';
      healthCpu = Number.isFinite(health.cpu_temp_c) ? health.cpu_temp_c : null;
      setText('runtime-cpu', number(cpuTemperature(), 0, ' °C'));
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
    reading('status-gyro', showImu ? vector(imu.gyro_rad_s) : '--', historical);
    reading('status-gravity', showImu ? vector(imu.gravity) : '--', historical);
    reading('status-quaternion', showImu && Array.isArray(imu.quaternion_wxyz) && imu.quaternion_wxyz.every(Number.isFinite)
      ? imu.quaternion_wxyz.map(value => value.toFixed(3)).join('  /  ') : '--', historical);
    if (info.head_imu_enabled !== false) {
      const aux = state.aux_imu || {};
      for (const [index, axis] of ['roll', 'pitch', 'yaw'].entries()) {
        setText(`aux-curve-${axis}`, auxiliary.valid ? `${aux.rpy_deg[index].toFixed(1)}°` : '--');
      }
      reading('aux-gyro', auxiliary.valid ? vector(aux.gyro_rad_s) : '--');
      reading('aux-gravity', auxiliary.valid ? vector(aux.gravity) : '--');
      reading('aux-quaternion', auxiliary.valid ? aux.quaternion_wxyz.map(value => value.toFixed(3)).join('  /  ') : '--');
      const auxNotice = auxiliary.valid || auxiliary.kind === 'pending' ? '' : auxiliary.detail !== auxiliary.label
        ? `${auxiliary.label}：${auxiliary.detail}` : auxiliary.label;
      const transientAux = transientHandoff && ['starting', 'waiting', 'stale'].includes(auxiliary.kind);
      if (!transientAux && auxNotice !== lastAuxNotice) {
        lastAuxNotice = auxNotice;
        if (auxNotice) toast(`头部 IMU：${auxNotice}`, !['starting', 'waiting'].includes(auxiliary.kind));
      }
      get('aux-imu-caption').hidden = !auxiliary.valid;
    }
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
        setLocalizedText(cell, values[index], index === 6);
        setLocalizedAttribute(cell, 'title', index >= 7 && servo?.configuration_error ? servo.configuration_error : values[index], index === 6);
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
  function renderHealth(health) {
    const throttle = health?.cpu_throttle;
    const throttled = throttle?.level > 0 || (throttle?.max_khz > 0 && throttle.khz < throttle.max_khz);
    get('topbar-cpu-throttled').hidden = !throttled;
  }

  function renderResources(resources) {
    setText('runtime-storage', formatResourceUsage(resources?.storage));
    setText('runtime-memory', formatResourceUsage(resources?.memory));
    resourceCpu = Number.isFinite(resources?.cpu_temp_c) ? resources.cpu_temp_c : null;
    const now = performance.now();
    resourceCpuAt = now;
    setText('runtime-cpu', number(cpuTemperature(), 0, ' °C'));
    setText('topbar-cpu-temperature', number(resourceCpu, 0, ' °C'));

    const memory = resources?.memory;
    const memoryFraction = usageFraction(memory?.used_bytes, memory?.total_bytes);
    setText('topbar-memory-usage', memoryFraction === null ? '--' : number(memoryFraction * 100, 0, '%'));

    const cpu = resources?.cpu;
    const busy = cpu?.busy_ticks, total = cpu?.total_ticks;
    let cpuFraction = null;
    if (Number.isSafeInteger(busy) && Number.isSafeInteger(total) && usageFraction(busy, total) !== null) {
      if (previousCpu && now - previousCpu.at <= 15000) {
        cpuFraction = usageFraction(busy - previousCpu.busy, total - previousCpu.total);
      }
      previousCpu = { busy, total, at: now };
    } else {
      previousCpu = null;
    }
    setText('topbar-cpu-usage', cpuFraction === null ? '--' : number(cpuFraction * 100, 0, '%'));
  }

  return { render, renderHealth, renderResources };
}
