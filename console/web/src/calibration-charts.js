const WINDOW_MS = 20000;
const HEAD_SAMPLE_MAX_AGE_US = 500000;
const READONLY_SAMPLE_MAX_AGE_US = 1500000;

function usable(sample, maxAgeUs = 100000) {
  return sample && sample.frame === 'sensor' && Number.isFinite(sample.timestamp_ms) &&
    Number.isFinite(sample.age_us) && sample.age_us >= 0 && sample.age_us <= maxAgeUs &&
    ['raw_g', 'corrected_g', 'gyro_rad_s', 'raw_gyro_rad_s'].every(field =>
      Array.isArray(sample[field]) && sample[field].length === 3 && sample[field].every(Number.isFinite));
}

export function createCalibrationCharts({ request, context, onStatus }) {
  const get = id => document.getElementById(id);
  const charts = ['accel-chart', 'gyro-chart'].map(get);
  let active = false, timer = null, pending = false, generation = 0, latestState = {}, idleStatus = '等待采样';
  let source = 'body';
  let live = [], lastSample = '';
  const visibility = {
    'accel-chart': { raw: [true, true, true], corrected: [true, true, true] },
    'gyro-chart': { raw: [true, true, true], corrected: [true, true, true] },
  };

  function streamNotice(message, error = false) {
    onStatus(message, error);
  }

  function add(sample, source, maxAgeUs) {
    if (!usable(sample, maxAgeUs)) return;
    const key = `${source}:${sample.sequence}:${sample.timestamp_ms}`;
    if (key === lastSample) return;
    lastSample = key;
    const entry = {
      ...sample,
      corrected_gyro_rad_s: sample.corrected_gyro_rad_s || sample.gyro_rad_s,
      accel_calibrated: sample.accel_calibrated === true || sample.calibrated === true,
      gyro_calibrated: sample.gyro_calibrated === true,
      received: performance.now(), source,
    };
    live.push(entry);
    live = live.filter(item => entry.received - item.received <= WINDOW_MS);
    updateValues(entry);
    draw();
  }

  function updateValues(sample) {
    const readings = [
      { id: 'accel-values', chart: 'accel-chart', raw: 'raw_g', corrected: 'corrected_g', flag: 'accel_calibrated' },
      { id: 'gyro-values', chart: 'gyro-chart', raw: 'raw_gyro_rad_s', corrected: 'corrected_gyro_rad_s', flag: 'gyro_calibrated' },
    ];
    for (const reading of readings) {
      const parent = get(reading.id);
      if (!parent.children.length) {
        for (let axis = 0; axis < 3; axis++) {
          const item = document.createElement('span');
          item.className = 'axis-readout';
          item.dataset.axis = 'xyz'[axis];
          const label = document.createElement('b');
          label.className = 'axis-name';
          label.textContent = 'XYZ'[axis];
          item.append(label);
          for (const [kind, description] of [['raw', '原始'], ['corrected', '校准后']]) {
            const line = document.createElement('span');
            line.className = 'axis-series';
            line.dataset.series = kind;
            const toggle = document.createElement('input');
            toggle.type = 'checkbox';
            toggle.checked = true;
            toggle.setAttribute('aria-label', `${label.textContent} 轴${description}曲线`);
            toggle.title = '勾选显示曲线';
            toggle.addEventListener('change', () => {
              visibility[reading.chart][kind][axis] = toggle.checked;
              draw();
            });
            const value = document.createElement('span');
            value.className = 'axis-series-value';
            line.append(toggle, value);
            item.append(line);
          }
          parent.append(item);
        }
      }
      [...parent.children].forEach((child, axis) => {
        const raw = sample?.[reading.raw]?.[axis];
        const corrected = sample?.[reading.corrected]?.[axis];
        const calibrated = sample?.[reading.flag] === true && Number.isFinite(corrected);
        const rawNode = child.querySelector('[data-series=raw] .axis-series-value');
        const rawText = `原始 ${Number.isFinite(raw) ? raw.toFixed(3) : '--'}`;
        if (rawNode.textContent !== rawText) rawNode.textContent = rawText;
        const correctedNode = child.querySelector('[data-series=corrected]');
        correctedNode.hidden = !calibrated;
        const value = correctedNode.querySelector('.axis-series-value');
        const text = `校准后 ${Number.isFinite(corrected) ? corrected.toFixed(3) : '--'}`;
        if (value.textContent !== text) value.textContent = text;
      });
    }
  }

  function drawCanvas(canvas, realtime) {
    const width = canvas.clientWidth, height = canvas.clientHeight;
    if (!width || !height) return;
    const dpr = Math.min(devicePixelRatio, 1.5);
    const pixelWidth = Math.floor(width * dpr), pixelHeight = Math.floor(height * dpr);
    if (canvas.width !== pixelWidth || canvas.height !== pixelHeight) {
      canvas.width = pixelWidth; canvas.height = pixelHeight;
    }
    const ctx = canvas.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, width, height);
    const style = getComputedStyle(document.documentElement);
    const chartStyle = getComputedStyle(canvas);
    const colors = ['--calibration-x', '--calibration-y', '--calibration-z'].map(name => chartStyle.getPropertyValue(name).trim());
    const now = performance.now();
    const recent = live.filter(item => now - item.received <= WINDOW_MS);
    const calibrated = recent.at(-1)?.[realtime.flag] === true;
    const series = [
      { items: recent, field: realtime.raw, kind: 'raw', dashed: calibrated },
      ...(calibrated ? [{
        items: recent.filter(item => item[realtime.flag]),
        field: realtime.corrected,
        kind: 'corrected',
        dashed: false,
      }] : []),
    ];
    const left = 24, right = width - 45, lane = (height - 18) / 3;
    ctx.font = '11px system-ui, sans-serif';
    for (let axis = 0; axis < 3; axis++) {
      // Keep the axis scale stable when a curve is hidden.
      const values = series.flatMap(line => line.items.map(item => item[line.field][axis]));
      const minimum = values.length ? Math.min(...values) : 0;
      const maximum = values.length ? Math.max(...values) : 0;
      const centerValue = (minimum + maximum) / 2;
      const half = Math.max(realtime.raw === 'raw_g' ? .03 : .005, (maximum - minimum) * .6);
      const top = axis * lane + 3, bottom = (axis + 1) * lane - 3, mid = (top + bottom) / 2;
      ctx.strokeStyle = style.getPropertyValue('--chart-grid');
      ctx.setLineDash([]); ctx.lineWidth = 1; ctx.beginPath(); ctx.moveTo(left, mid); ctx.lineTo(right, mid); ctx.stroke();
      ctx.fillStyle = colors[axis]; ctx.textAlign = 'left'; ctx.fillText('XYZ'[axis], 2, mid + 4);
      ctx.fillStyle = style.getPropertyValue('--chart-text'); ctx.textAlign = 'right';
      ctx.fillText((centerValue + half).toFixed(2), width - 1, top + 9);
      ctx.fillText((centerValue - half).toFixed(2), width - 1, bottom);
      for (const line of series) {
        if (!line.items.length || !visibility[canvas.id][line.kind][axis]) continue;
        ctx.save(); ctx.beginPath(); ctx.rect(left, top, right - left, bottom - top); ctx.clip();
        ctx.strokeStyle = colors[axis]; ctx.lineWidth = 1.5;
        ctx.setLineDash(line.dashed ? [4, 3] : []); ctx.beginPath();
        let previous = null;
        for (const item of line.items) {
          const elapsed = WINDOW_MS - (now - item.received);
          const x = left + (right - left) * elapsed / WINDOW_MS;
          const y = mid - (item[line.field][axis] - centerValue) / half * (bottom - top) / 2;
          if (!previous || item.timestamp_ms - previous.timestamp_ms > 1500 || item.timestamp_ms < previous.timestamp_ms) ctx.moveTo(x, y);
          else ctx.lineTo(x, y);
          previous = item;
        }
        ctx.stroke(); ctx.restore();
      }
    }
    ctx.fillStyle = style.getPropertyValue('--chart-text'); ctx.textAlign = 'left';
    ctx.fillText('-20 s', left, height - 2);
    ctx.textAlign = 'right'; ctx.fillText('0 s', right, height - 2);
  }

  function draw() {
    if (!active) return;
    const latest = live.at(-1);
    const accelCalibrated = latest?.accel_calibrated === true;
    const gyroCalibrated = latest?.gyro_calibrated === true;
    const setLegend = (id, calibrated) => {
      const legend = get(id);
      legend.querySelector('[data-series=raw]').textContent = `${calibrated ? '虚线' : '实线'} 原始`;
      legend.querySelector('[data-series=corrected]').hidden = !calibrated;
    };
    setLegend('accel-series-legend', accelCalibrated);
    setLegend('gyro-series-legend', gyroCalibrated);
    drawCanvas(charts[0], {
      raw: 'raw_g', corrected: 'corrected_g', flag: 'accel_calibrated',
    });
    drawCanvas(charts[1], {
      raw: 'raw_gyro_rad_s', corrected: 'corrected_gyro_rad_s', flag: 'gyro_calibrated',
    });
  }

  function updateState(state, error = '') {
    latestState = state || {};
    const calibration = (source === 'head' ? latestState.head_calibration : latestState.calibration) || {};
    if (!active) return;
    const auxiliary = latestState.aux_imu;
    const elapsed = Math.max(0, context().elapsed || 0);
    if (error) { streamNotice(`连接中断：${error}`, true); updateValues(null); }
    else if (source === 'head') {
      const sample = auxiliary?.sample && {
        ...auxiliary.sample,
        age_us: auxiliary.sample.age_us + elapsed * 1000,
        accel_calibrated: auxiliary.accel_calibrated === true,
        gyro_calibrated: auxiliary.gyro_calibrated === true,
      };
      const fresh = auxiliary?.valid && Number.isFinite(auxiliary.age_ms) && auxiliary.age_ms + elapsed <= 500 && usable(sample, HEAD_SAMPLE_MAX_AGE_US);
      const status = fresh
        ? (calibration.active && !calibration.waiting ? '采样中' : '')
        : auxiliary?.error || '等待头部 IMU 采样';
      streamNotice(status, Boolean(auxiliary?.error));
      if (fresh) add(sample, 'console', HEAD_SAMPLE_MAX_AGE_US); else updateValues(null);
    }
    else if (calibration.active) {
      const fresh = calibration.sample && calibration.sample_age_ms + elapsed < 1200;
      const status = calibration.sample_error ? `采样失败：${calibration.sample_error}` : fresh
        ? (calibration.waiting ? '等待摆放 · 实时采样' : `采样中 · ${calibration.sample.phase}`) : '等待校准采样';
      streamNotice(status, Boolean(calibration.sample_error));
      if (fresh) add(calibration.sample, 'calibration'); else updateValues(null);
    } else {
      if (context().info?.readonly && latestState.imu?.valid && latestState.imu?.raw_sample) {
        const sample = { ...latestState.imu.raw_sample,
          age_us: latestState.imu.raw_sample.age_us + elapsed * 1000 };
        if (usable(sample, READONLY_SAMPLE_MAX_AGE_US)) {
          idleStatus = '实时 · 传感器坐标（只读）';
          add(sample, 'console', READONLY_SAMPLE_MAX_AGE_US);
        }
      }
      const stale = !live.length || live.at(-1).source !== 'console' || performance.now() - live.at(-1).received > 1200;
      const status = stale && idleStatus.startsWith('实时') ? '等待新样本' : idleStatus;
      streamNotice(status.startsWith('实时 · 传感器坐标') ? '' : status,
        status === '躯体 IMU 读取超时' || status.startsWith('采样不可用'));
      if (stale) updateValues(null);
    }
  }

  async function poll(current) {
    if (!active || current !== generation) return;
    const { info, connectionError } = context();
    if (source === 'body' && !pending && info && !connectionError && !latestState.calibration?.active) {
      if (info.readonly || latestState.imu_source === 'i2c') {
        idleStatus = info.readonly ? (latestState.imu?.raw_sample
          ? '实时 · 传感器坐标（只读）' : '等待 IMU 原始六轴数据') : '当前来源不是 ID200';
      } else if (info.studio && !latestState.maintenance_owner) {
        idleStatus = latestState.maintenance_error || '等待采样';
      } else {
        pending = true;
        try {
          const sample = await request('command', { action: 'imu_sample' });
          if (active && current === generation && !latestState.calibration?.active) {
            idleStatus = sample.ready ? '实时 · 传感器坐标' : '实时 · 融合未就绪';
            add(sample, 'console');
          }
        } catch (error) {
          if (active && current === generation && !latestState.calibration?.active) {
            idleStatus = error.message === '躯体 IMU 读取超时' ? error.message : `采样不可用：${error.message}`;
          }
        } finally { pending = false; }
      }
    }
    if (current !== generation) return;
    updateState(latestState, context().connectionError);
    if (active) timer = setTimeout(() => poll(current), 250);
  }

  function setActive(value) {
    active = value;
    generation++;
    clearTimeout(timer);
    if (!active) streamNotice('');
    if (active) { draw(); poll(generation); }
  }
  function setSource(value) {
    if (!['body', 'head'].includes(value) || value === source) return;
    source = value;
    generation++;
    clearTimeout(timer);
    live = [];
    lastSample = '';
    streamNotice('');
    idleStatus = '等待采样';
    updateValues(null);
    if (active) { draw(); poll(generation); }
  }
  updateValues(null);
  for (const canvas of charts) new ResizeObserver(draw).observe(canvas);
  return { setActive, setSource, updateState, draw };
}
