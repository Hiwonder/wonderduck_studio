import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { createElement, RotateCcw } from 'lucide';
import { imuFresh } from './state-status.js';

const FACES = ['+X', '-X', '+Y', '-Y', '+Z', '-Z'];
const UP = new THREE.Vector3(0, 1, 0);
const SENSOR_TO_BODY = new THREE.Quaternion(.5, .5, .5, .5);
const BODY_TO_VIEW = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), -Math.PI / 2);

function finiteVector(value, length) {
  return Array.isArray(value) && value.length === length && value.every(Number.isFinite);
}

function viewVector(value) {
  return new THREE.Vector3(value.x, value.z, -value.y);
}

export function faceVector(face) {
  if (!FACES.includes(face)) return null;
  const axis = 'XYZ'.indexOf(face[1]);
  const value = new THREE.Vector3();
  value.setComponent(axis, face[0] === '+' ? 1 : -1);
  return value;
}

export function tiltForSensorVector(values, source) {
  if (!finiteVector(values, 3) || !['body', 'head'].includes(source)) return null;
  const direction = new THREE.Vector3(...values);
  if (!direction.lengthSq()) return null;
  if (source === 'body') direction.applyQuaternion(SENSOR_TO_BODY);
  return new THREE.Quaternion().setFromUnitVectors(viewVector(direction).normalize(), UP);
}

export function orientationInView(values) {
  if (!finiteVector(values, 4)) return null;
  const [w, x, y, z] = values;
  const rotation = new THREE.Quaternion(x, y, z, w);
  if (Math.abs(rotation.length() - 1) >= .05) return null;
  return BODY_TO_VIEW.clone().multiply(rotation.normalize()).multiply(BODY_TO_VIEW.clone().invert());
}

export function suggestedFace(calibration) {
  if (!calibration?.active || calibration.sensor !== 'accel') return null;
  const pending = calibration.pending_faces;
  if (!Array.isArray(pending) || pending.some(face => !FACES.includes(face)) || new Set(pending).size !== pending.length) return null;
  // Once identified, keep showing the measured face throughout verification.
  if (!calibration.waiting && pending.includes(calibration.current_face)) return calibration.current_face;
  return pending[0] || null;
}

export function currentCalibrationPose(source, state, elapsed = 0, error = '') {
  if (error) return { detail: `连接中断：${error}` };
  const calibration = source === 'head' ? state?.head_calibration : state?.calibration;
  if (calibration?.active) {
    const age = calibration.sample_age_ms;
    const sample = calibration.sample;
    const limit = source === 'head' ? 500 : 1200;
    if (calibration.sample_error) return { detail: `采样不可用：${calibration.sample_error}` };
    if (!Number.isFinite(age) || age < 0 || age + Math.max(0, elapsed) >= limit || sample?.frame !== 'sensor') {
      return { detail: '等待实时采样' };
    }
    const rotation = tiltForSensorVector(sample.corrected_g, source);
    return rotation ? { rotation, detail: '实时倾角 · 传感器坐标' } : { detail: '加速度方向无效' };
  }
  if (source === 'body') {
    if (!imuFresh(state?.imu, state, elapsed, error)) return { detail: '躯体 IMU 数据不可用' };
    const rotation = orientationInView(state.imu.quaternion_wxyz);
    return rotation ? { rotation, detail: '实时姿态 · 机身坐标' } : { detail: '躯体 IMU 姿态无效' };
  }
  const imu = state?.aux_imu;
  if (!imu?.valid || imu.status !== 'ok' || !Number.isFinite(imu.age_ms) || imu.age_ms < 0 ||
      imu.age_ms + Math.max(0, elapsed) >= 500) return { detail: imu?.error || '头部 IMU 数据不可用' };
  const rotation = orientationInView(imu.quaternion_wxyz);
  return rotation ? { rotation, detail: '实时姿态 · 传感器坐标' } : { detail: '头部 IMU 姿态无效' };
}

function labelSprite(text, color) {
  const canvas = document.createElement('canvas');
  canvas.width = 128; canvas.height = 64;
  const context = canvas.getContext('2d');
  context.font = `600 36px ${getComputedStyle(document.documentElement).fontFamily}`;
  context.textAlign = 'center'; context.textBaseline = 'middle';
  context.fillStyle = color; context.fillText(text, 64, 32);
  const texture = new THREE.CanvasTexture(canvas); texture.colorSpace = THREE.SRGBColorSpace;
  const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: texture, transparent: true, depthTest: false, toneMapped: false }));
  sprite.scale.set(.45, .225, 1);
  return sprite;
}

function sensorAxes() {
  const group = new THREE.Group();
  const origin = new THREE.Mesh(new THREE.SphereGeometry(.12, 20, 12), new THREE.MeshStandardMaterial({ color: '#9eabb0' }));
  group.add(origin);
  for (const [axis, color] of [['X', '#2774cc'], ['Y', '#bd8900'], ['Z', '#18874f']]) {
    const direction = viewVector(faceVector(`+${axis}`));
    group.add(new THREE.ArrowHelper(direction, new THREE.Vector3(), 1.05, color, .22, .1));
    const negative = new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), direction.clone().multiplyScalar(-.7)]);
    group.add(new THREE.Line(negative, new THREE.LineBasicMaterial({ color, transparent: true, opacity: .45 })));
    const label = labelSprite(`+${axis}`, color);
    label.position.copy(direction.clone().multiplyScalar(1.25));
    group.add(label);
  }
  return group;
}

function panelScene() {
  const scene = new THREE.Scene();
  scene.add(new THREE.HemisphereLight('#ffffff', '#89999b', 2.7));
  const light = new THREE.DirectionalLight('#fffaf1', 2.5); light.position.set(3, 4, 3); scene.add(light);
  const grid = new THREE.GridHelper(2.3, 8, '#89999a', '#b6c2bc');
  grid.position.y = -1.02;
  grid.material.transparent = true; grid.material.opacity = .3;
  scene.add(grid);
  const body = new THREE.Group(), sensor = sensorAxes();
  scene.add(body, sensor);
  body.visible = false; sensor.visible = false;
  return { scene, body, sensor };
}

function normalizedModel(model) {
  const clone = model.clone(true);
  const wrapper = new THREE.Group(); wrapper.add(clone);
  const bounds = new THREE.Box3().setFromObject(wrapper);
  const size = bounds.getSize(new THREE.Vector3());
  const center = bounds.getCenter(new THREE.Vector3());
  const longest = Math.max(size.x, size.y, size.z);
  if (!Number.isFinite(longest) || longest <= 0) throw new Error('校准模型尺寸无效');
  clone.position.sub(center);
  wrapper.scale.setScalar(1.65 / longest);
  return wrapper;
}

export function createCalibrationView({ viewer, renderer, onError, onRelease }) {
  const container = document.createElement('div');
  container.className = 'calibration-view'; container.hidden = true;
  container.innerHTML = '<div class="calibration-views">' +
    '<section class="calibration-view-pane" aria-label="实时姿态"><div class="calibration-view-heading"><strong>实时姿态</strong><span data-calibration-live-status role="status">等待实时采样</span></div></section>' +
    '<section class="calibration-view-pane" aria-label="建议摆放姿态"><div class="calibration-view-heading"><strong>建议摆放</strong><span data-calibration-target-status role="status">等待六面校准</span></div></section>' +
    '</div>';
  const reset = document.createElement('button');
  reset.type = 'button'; reset.className = 'calibration-view-reset icon';
  reset.title = reset.ariaLabel = '复位校准视角'; reset.append(createElement(RotateCcw));
  container.append(reset); viewer.append(container);
  const panes = [...container.querySelectorAll('.calibration-view-pane')];
  const labels = [container.querySelector('[data-calibration-live-status]'), container.querySelector('[data-calibration-target-status]')];
  const scenes = [panelScene(), panelScene()];
  const dirty = [true, true];
  const invalidate = () => { dirty[0] = dirty[1] = true; };
  if (!renderer) {
    labels.forEach(label => { label.textContent = '3D 显示不可用'; });
  }
  const cameras = panes.map(() => new THREE.PerspectiveCamera(35, 1, .01, 50));
  const controls = renderer ? cameras.map((camera, index) => {
    const control = new OrbitControls(camera, panes[index]);
    control.enableDamping = true; control.minDistance = 2.5; control.maxDistance = 9;
    return control;
  }) : [];
  function resetView() {
    cameras.forEach((camera, index) => {
      if (controls[index]) { controls[index].enableDamping = false; controls[index].update(); }
      camera.position.set(3.4, 2.5, 3.8);
      if (controls[index]) {
        controls[index].target.set(0, 0, 0); controls[index].update(); controls[index].enableDamping = true;
      }
    });
    invalidate();
  }
  reset.addEventListener('click', resetView); resetView();
  let active = false, source = 'body', latest = {}, elapsedAtUpdate = 0, receivedAt = performance.now(), connectionError = '';
  let frame = 0, lastFrame = 0, modelReady = false;

  function updateScene() {
    const elapsed = elapsedAtUpdate + Math.max(0, performance.now() - receivedAt);
    const live = currentCalibrationPose(source, latest, elapsed, connectionError);
    const calibration = source === 'head' ? latest.head_calibration : latest.calibration;
    const face = suggestedFace(calibration);
    const target = face && tiltForSensorVector(faceVector(face).toArray(), source);
    for (const [index, rotation] of [live.rotation, target].entries()) {
      const stage = scenes[index];
      const visible = !!rotation && (source === 'head' || modelReady);
      const bodyVisible = visible && source === 'body', sensorVisible = visible && source === 'head';
      if (stage.body.visible !== bodyVisible || stage.sensor.visible !== sensorVisible) dirty[index] = true;
      stage.body.visible = bodyVisible;
      stage.sensor.visible = sensorVisible;
      const object = source === 'body' ? stage.body : stage.sensor;
      if (visible && !object.quaternion.equals(rotation)) { object.quaternion.copy(rotation); dirty[index] = true; }
      if (panes[index].dataset.valid !== String(visible)) panes[index].dataset.valid = String(visible);
      const pose = visible ? rotation.toArray().map(value => value.toFixed(6)).join(',') : '';
      if (panes[index].dataset.pose !== pose) panes[index].dataset.pose = pose;
    }
    const liveLabel = source === 'body' && live.rotation && !modelReady ? '模型加载中' : live.detail;
    const targetLabel = face && source === 'body' && !modelReady ? '模型加载中'
      : face ? `建议 ${face} · 传感器轴朝上` : '等待六面摆放建议';
    if (labels[0].textContent !== liveLabel) labels[0].textContent = liveLabel;
    if (labels[1].textContent !== targetLabel) labels[1].textContent = targetLabel;
    if (container.dataset.source !== source) container.dataset.source = source;
    if (container.dataset.suggestedFace !== (face || '')) container.dataset.suggestedFace = face || '';
  }

  function resize() {
    if (!renderer || !active || !container.clientWidth || !container.clientHeight) return;
    renderer.setSize(container.clientWidth, container.clientHeight, false);
    panes.forEach((pane, index) => {
      cameras[index].aspect = Math.max(1, pane.clientWidth) / Math.max(1, pane.clientHeight);
      cameras[index].updateProjectionMatrix();
    });
    invalidate();
  }
  new ResizeObserver(resize).observe(container);
  function draw(now) {
    if (!active) return;
    frame = requestAnimationFrame(draw);
    if (!renderer || document.hidden || now - lastFrame < 1000 / 30) return;
    lastFrame = now;
    updateScene();
    controls.forEach((control, index) => { if (control.update()) dirty[index] = true; });
    if (!dirty.some(Boolean)) return;
    const bounds = container.getBoundingClientRect();
    renderer.autoClear = false;
    renderer.setScissorTest(true);
    panes.forEach((pane, index) => {
      if (!dirty[index]) return;
      dirty[index] = false;
      const rect = pane.getBoundingClientRect();
      const left = rect.left - bounds.left, bottom = bounds.bottom - rect.bottom;
      renderer.setViewport(left, bottom, rect.width, rect.height);
      renderer.setScissor(left, bottom, rect.width, rect.height);
      renderer.clear();
      renderer.render(scenes[index].scene, cameras[index]);
    });
  }
  function setActive(value) {
    if (active === value) return;
    active = value; container.hidden = !active;
    if (active) {
      if (renderer) {
        renderer.domElement.classList.add('calibration-view-canvas');
        container.prepend(renderer.domElement);
      } else onError('校准 3D 显示不可用');
      resize(); frame = requestAnimationFrame(draw);
    } else {
      cancelAnimationFrame(frame);
      if (renderer) {
        renderer.domElement.classList.remove('calibration-view-canvas');
        viewer.append(renderer.domElement);
        renderer.autoClear = true;
        renderer.setScissorTest(false);
        onRelease();
      }
    }
  }
  function setSource(value) {
    if (!['body', 'head'].includes(value)) throw new Error('未知校准来源');
    source = value;
  }
  function update(state, elapsed = 0, error = '') {
    latest = state || {}; elapsedAtUpdate = Math.max(0, elapsed); receivedAt = performance.now(); connectionError = error;
  }
  function setRobotModel(model) {
    for (const stage of scenes) {
      stage.body.clear();
      stage.body.add(normalizedModel(model));
    }
    modelReady = true;
    invalidate();
  }
  return { setActive, setSource, update, setRobotModel, invalidate };
}
