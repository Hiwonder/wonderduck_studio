import { setLocalizedText } from '../../../webpadd/web/language.js';

export function createCalibrationControls({ request, confirmAction, toast }) {
  const get = id => document.getElementById(id);
  const setText = (element, value) => setLocalizedText(element, value);
  let pending = false;
  let bodyState = {}, headState = {}, headImu = {};
  let selectedSource = 'body';
  let lastReport = '';
  let revision = 0;
  let demoMode = false;
  let imuSource = 'id200';
  let headAvailable = true;
  const announcedResults = new Map();

  async function command(body) {
    pending = true;
    render();
    const startedRevision = revision;
    const source = selectedSource;
    try {
      const headAction = { calibration_start: 'start', calibration_restore: 'restore', calibration_next: 'next', calibration_cancel: 'cancel' }[body.action];
      const result = source === 'head'
        ? await request('head-imu/calibration', { action: headAction, ...(body.sensor ? { sensor: body.sensor } : {}) })
        : await request('command', body);
      if (revision === startedRevision) {
        if (source === 'head') headState = result; else bodyState = result;
      }
    } catch (error) {
      toast(error.message, true);
    } finally {
      pending = false;
      render();
    }
  }

  async function start(sensor, resume = '') {
    const isHead = selectedSource === 'head';
    const text = isHead
      ? '确认机器人已支撑固定。预热、采集和验证期间请保持传感器静止。'
      : sensor === 'gyro'
        ? '确认机器人已支撑固定并松手。将全部卸力并暂停总线采集，预热、采集和验证期间请保持静止约 10 秒。'
        : '确认机器人已支撑固定。将全部卸力并暂停总线采集。';
    const title = `${isHead ? '头部' : '躯体'} IMU ${sensor === 'gyro' ? '陀螺仪' : '加速度'}校准`;
    if (!await confirmAction(title, text)) return;
    await command({ action: 'calibration_start', sensor, resume,
      face: resume ? get('calibration-face').value : '' });
  }

  async function restore(sensor) {
    const isHead = selectedSource === 'head';
    const title = `${isHead ? '头部' : '躯体'} IMU ${sensor === 'gyro' ? '陀螺仪' : '加速度'}恢复默认`;
    const text = isHead ? '将用此设备的默认标定替换当前标定。' : '将用此设备的默认标定替换当前标定，并卸力后加载到传感器。请先支撑固定机器人。';
    if (!await confirmAction(title, text)) return;
    await command({ action: 'calibration_restore', sensor });
  }

  get('calibration-accel').onclick = () => start('accel');
  if (get('calibration-gyro')) get('calibration-gyro').onclick = () => start('gyro');
  if (get('calibration-accel-default')) get('calibration-accel-default').onclick = () => restore('accel');
  if (get('calibration-gyro-default')) get('calibration-gyro-default').onclick = () => restore('gyro');
  get('calibration-resume').onclick = () => {
    const resume = get('calibration-record').value.trim();
    if (!resume) return toast('请选择已有记录', true);
    return start('accel', resume);
  };
  get('calibration-next').onclick = () => command({ action: 'calibration_next' });
  get('calibration-cancel').onclick = () => command({ action: 'calibration_cancel' });

  for (const button of document.querySelectorAll('[data-calibration-source]')) {
    button.addEventListener('click', () => {
      const source = button.dataset.calibrationSource;
      if (pending || bodyState.active || headState.active || source === selectedSource ||
          source === 'head' && !headAvailable) return;
      selectedSource = source;
      render();
      document.dispatchEvent(new CustomEvent('calibration-source-change', { detail: selectedSource }));
    });
  }

  function render(value = bodyState, demo = demoMode, source = imuSource, head = headState, auxiliary = headImu) {
    bodyState = value || {};
    headState = head || {};
    headImu = auxiliary || {};
    demoMode = demo;
    imuSource = source;
    revision++;
    const isHead = selectedSource === 'head';
    const current = isHead ? headState : bodyState;
    const active = !!current.active;
    if (active) announcedResults.delete(selectedSource);
    else if (['passed', 'failed', 'incomplete', 'cancelled'].includes(current.result)) {
      const key = JSON.stringify([current.session_id, current.report, current.result, current.message, current.error]);
      if (announcedResults.get(selectedSource) !== key) {
        announcedResults.set(selectedSource, key);
        const detail = current.error && current.error !== current.message ? `：${current.error}` : '';
        toast(`${isHead ? '头部' : '躯体'} IMU：${current.message || '校准结束'}${detail}`, current.result === 'failed');
      }
    }
    const calibrating = !!bodyState.active || !!headState.active;
    const readonly = imuSource === 'robotd';
    const unavailable = demo || readonly || (!isHead && imuSource === 'i2c');
    for (const button of document.querySelectorAll('[data-calibration-source]')) {
      button.disabled = pending || calibrating;
      button.setAttribute('aria-pressed', String(button.dataset.calibrationSource === selectedSource));
    }
    get('calibration-accel').disabled = pending || active || unavailable;
    get('calibration-resume').disabled = pending || active || unavailable;
    get('calibration-accel').title = !isHead && imuSource === 'i2c' ? 'I2C5 模式不向 MCU 发送校准命令' : '';
    get('calibration-resume').title = get('calibration-accel').title;
    const gyro = get('calibration-gyro');
    if (gyro) { gyro.disabled = pending || active || unavailable; gyro.title = get('calibration-accel').title; }
    for (const id of ['calibration-accel-default', 'calibration-gyro-default']) {
      const button = get(id);
      if (button) button.disabled = pending || calibrating || unavailable;
    }
    const profileStatus = get('calibration-profile-status');
    if (profileStatus) {
      profileStatus.hidden = !isHead;
      setText(profileStatus, headImu.valid && typeof headImu.accel_calibrated === 'boolean' && typeof headImu.gyro_calibrated === 'boolean'
        ? `加速度${headImu.accel_calibrated ? '已校准' : '未校准'} · 陀螺仪${headImu.gyro_calibrated ? '已校准' : '未校准'}`
        : '头部 IMU 校准状态不可用');
      profileStatus.title = headImu.error || '';
    }
    const resumeOptions = get('calibration-resume-options');
    if (resumeOptions) resumeOptions.hidden = isHead;
    get('calibration-record').disabled = active || readonly;
    get('calibration-face').disabled = active || readonly;
    get('calibration-next').disabled = pending || !current.waiting;
    get('calibration-cancel').disabled = pending || !active || current.operation === 'restore';
    const status = get('calibration-status');
    const terminal = !active && ['passed', 'failed', 'incomplete', 'cancelled'].includes(current.result);
    status.hidden = terminal;
    setText(status, terminal ? '' : current.message || '未开始');
    status.title = terminal ? '' : current.error || '';
    const faces = isHead ? current.pending_faces?.join(' ') : current.faces;
    setText(get('calibration-faces'), current.failed_faces?.length
      ? `未通过：${current.failed_faces.join(' ')}`
      : active && faces ? `待采：${faces}` : '');
    const check = typeof current.face_check === 'string' ? current.face_check : '';
    setText(get('calibration-check'), check.includes('尚缺')
      ? '本面静止检查通过，残差待六面齐全'
      : check.split('；')[0]);
    get('calibration-check').title = check;
    get('calibration-download').hidden = isHead || !current.report_exists || active;
    if (!isHead && current.sensor === 'accel' && current.report && current.report !== lastReport) {
      get('calibration-record').value = current.report;
      lastReport = current.report;
    }
  }
  render();
  return {
    render,
    source: () => selectedSource,
    setHeadAvailable(available) {
      headAvailable = available;
      if (!available && selectedSource === 'head') {
        selectedSource = 'body';
        render();
        document.dispatchEvent(new CustomEvent('calibration-source-change', { detail: selectedSource }));
      }
    },
  };
}
