export const SAMPLE_MAX_AGE_MS = 500;

export function sampleFresh(state, elapsed = 0, connectionError = '') {
  return !connectionError && !!state?.online && Number.isFinite(state.age_ms) &&
    state.age_ms >= 0 && state.age_ms + Math.max(0, elapsed) < SAMPLE_MAX_AGE_MS;
}

export function deviceFresh(device, state, elapsed = 0, connectionError = '') {
  return !connectionError && !!state?.online && !!device?.valid && Number.isFinite(device.age_ms) &&
    device.age_ms >= 0 && device.age_ms + Math.max(0, elapsed) < SAMPLE_MAX_AGE_MS;
}

export function auxImuStatus(imu, elapsed = 0, connectionError = '') {
  const result = (kind, label, detail = label, valid = false) => ({ kind, label, detail, valid });
  if (connectionError) return result('connection', '服务断开', connectionError);
  if (!imu) return result('starting', '等待采集');
  if (imu.status === 'stale' || (imu.valid && Number.isFinite(imu.age_ms) &&
      imu.age_ms + Math.max(0, elapsed) > 500)) return result('stale', '数据过期', imu.error || '头部 IMU 数据已超过 500 ms');
  const vector = (value, length) => Array.isArray(value) && value.length === length && value.every(Number.isFinite);
  if (imu.valid === true && imu.status === 'ok') {
    if (!Number.isFinite(imu.age_ms) || imu.age_ms < 0 || !Number.isInteger(imu.reset_count) || !vector(imu.rpy_deg, 3) ||
        !vector(imu.gyro_rad_s, 3) || !vector(imu.gravity, 3) || !vector(imu.quaternion_wxyz, 4)) {
      return result('invalid', '数据异常', '头部 IMU 数据格式无效');
    }
    return result('ok', '实时', `数据年龄 ${Math.round(imu.age_ms + Math.max(0, elapsed))} ms`, true);
  }
  const labels = { starting: '正在启动', waiting: '等待采集', stale: '数据过期', unavailable: '未检测到',
    configuration_error: '配置错误', communication_error: '通信中断', saturated: '传感器饱和', ok: '数据无效' };
  const label = labels[imu.status] || '数据异常';
  return result(imu.status || 'invalid', label, imu.error || label);
}

export function imuTraceContinues(previous, sample, axis) {
  return !!previous && sample.time - previous.time <= 600 &&
    Math.abs(sample.angles[axis] - previous.angles[axis]) <= 180 &&
    sample.reset_count === previous.reset_count;
}

export function tofStatus(tof, elapsed = 0, connectionError = '', studio = false) {
  const result = (kind, label, detail, distance = '--', raw = '') => ({ kind, label, detail, distance, raw });
  if (connectionError) return result('connection', '服务断开', connectionError);
  if (!tof) return result('starting', '等待数据', '等待 TOF 数据');
  if (['ok', 'out_of_range'].includes(tof.status) &&
      (!Number.isFinite(tof.age_ms) || tof.age_ms < 0 || tof.age_ms + Math.max(0, elapsed) > 1500)) {
    return result('stale', studio ? '暂无数据' : '数据过期', 'TOF 数据已过期');
  }
  if (tof.status === 'ok' && tof.valid && Number.isInteger(tof.distance_mm)) {
    return result('ok', '正常', `数据年龄 ${tof.age_ms} ms`, `${tof.distance_mm} mm`);
  }
  if (tof.status === 'out_of_range') {
    return result('out_of_range', studio ? '超出测量范围' : '超范围/无回波',
      tof.error || (studio ? '距离读数超出量程' : '无有效测距回波'), '--',
      Number.isInteger(tof.distance_mm) ? `原始值 ${tof.distance_mm}` : '');
  }
  const labels = {
    starting: studio ? '正在采样' : '连接中', not_detected: studio ? '设备不可用' : '未检测到', bus_unavailable: '总线不可用',
    communication_error: studio ? '测距异常' : '通信中断', permission_error: '权限不足', dependency_error: '依赖缺失',
    timeout: '测距超时', invalid_data: studio ? '超出测量范围' : '数据异常', worker_error: '采集进程异常',
    stale: studio ? '暂无数据' : '数据过期', error: '测距异常',
  };
  const known = Object.hasOwn(labels, tof.status);
  const label = known ? labels[tof.status] : '数据异常';
  return result(known ? tof.status : 'invalid_data', label, tof.error || label);
}

export function servoStatus(servo, state, elapsed = 0, connectionError = '') {
  const fresh = deviceFresh(servo, state, elapsed, connectionError);
  const valid = !state?.device_paused && fresh && servo?.online !== false;
  const result = (kind, label, title) => ({ kind, label, title, valid, fresh });
  if (connectionError) return result('connection', '连接中断', connectionError);
  if (state?.device_paused) return result('paused', '维护占用', '维护占用，独立采集暂停');
  if (!state?.online) return result('acquisition', '采集异常', state?.error || '尚未取得采集数据');
  if (!servo) return result('invalid', '数据异常', '本次采集没有该舵机的状态');
  const observationAge = servo.observation_age_ms;
  if (!Number.isFinite(observationAge)) return result('waiting', '等待采集', servo.error || '尚未读取该舵机');
  if (observationAge < 0 || observationAge + Math.max(0, elapsed) >= SAMPLE_MAX_AGE_MS) {
    const label = servo.valid ? '数据过期' : /超时|timeout/i.test(servo.error || '') ? '读取超时（已过期）' : '读取失败（已过期）';
    return result('stale', label, ['该舵机的读取结果已超过 500 ms', servo.error].filter(Boolean).join('；'));
  }
  if (servo.online === false) {
    return /校验|帧长度/.test(servo.error || '')
      ? result('communication', '通信异常', servo.error)
      : result('offline', /超时|timeout/i.test(servo.error || '') ? '读取超时' : '读取失败',
        servo.error || '本次读取未收到舵机回复');
  }
  if (servo.valid && !fresh) return result('stale', '数据过期', '该舵机的采样数据已超过 500 ms');
  const torque = ({ 0: '关闭', 1: '开启', 128: '校准' })[servo.torque] || '--';
  const details = [`在线；扭矩寄存器：${torque}`];
  if (fresh) details.push(`采样年龄 ${Math.round(servo.age_ms + Math.max(0, elapsed))} ms`);
  if (servo.faults?.length) {
    details.push(servo.faults.join('、'), `故障码 0x${servo.status.toString(16).padStart(2, '0').toUpperCase()}`);
    if (servo.error) details.push(servo.error);
    const shortLabels = { '电压异常': '电压', '传感器异常': '传感器', '角度异常': '角度' };
    const fault = servo.faults[0];
    const label = servo.faults.length > 1 ? '多故障' : shortLabels[fault] || (fault.startsWith('未知故障') ? '未知故障' : fault);
    return result('fault', label, details.join('；'));
  }
  if (!servo.valid) return result('invalid', '数据异常', [...details, servo.error || '读数无效'].join('；'));
  if (servo.diagnostics_available === false) {
    return result('normal', '未发布', 'robotd 已发布关节反馈；扭矩、报警、负载、电压和温度未发布');
  }
  return result('normal', torque, details.join('；'));
}
