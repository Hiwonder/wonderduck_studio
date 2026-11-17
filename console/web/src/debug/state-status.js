export function sampleFresh(state, elapsed = 0, connectionError = '') {
  return !connectionError && !!state?.online && Number.isFinite(state.age_ms) &&
    state.age_ms >= 0 && state.age_ms + Math.max(0, elapsed) < 500;
}

export function servoStatus(servo, state, elapsed = 0, connectionError = '') {
  const fresh = sampleFresh(state, elapsed, connectionError);
  const valid = fresh && servo?.online !== false && !!servo?.valid;
  const result = (kind, label, title) => ({ kind, label, title, valid, fresh });
  if (connectionError) return result('connection', '连接中断', connectionError);
  if (!state?.online) return result('acquisition', '采集异常', state?.error || '尚未取得采集数据');
  if (!fresh) return result('stale', '数据过期', '采集数据已超过 500 ms');
  if (!servo) return result('invalid', '数据异常', '本次采集没有该舵机的状态');
  if (servo.online === false) {
    return /校验|帧长度/.test(servo.error || '')
      ? result('communication', '通信异常', servo.error)
      : result('offline', '离线', servo.error || '本次读取未收到舵机回复');
  }
  const torque = ({ 0: '关闭', 1: '开启', 128: '校准' })[servo.torque] || '--';
  const details = [`在线；扭矩寄存器：${torque}`];
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
