import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { createElement, RotateCcw } from 'lucide';
import { deviceFresh, imuFresh, SERVO_STATUS_MAX_AGE_MS } from './state-status.js';

const FACES = ['+X', '-X', '+Y', '-Y', '+Z', '-Z'];
const UP = new THREE.Vector3(0, 1, 0);
const SENSOR_TO_BODY = new THREE.Quaternion(.5, .5, .5, .5);
const BODY_TO_VIEW = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), -Math.PI / 2);
// The RK3566 head QMI8658 reports +Y and +Z opposite to the CAD IMU frame.
const HEAD_SENSOR_TO_CAD = new THREE.Quaternion(1, 0, 0, 0);

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
  const pose = new THREE.Group();
  scene.add(pose);
  pose.visible = false;
  return { scene, pose, axes: null, bodySensor: null, headSensor: null, joints: new Map() };
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

function modelSensorAxes() {
  const axes = sensorAxes();
  axes.scale.setScalar(.38);
  axes.visible = false;
  axes.traverse(object => {
    if (!object.material) return;
    object.material.depthTest = false;
    object.material.depthWrite = false;
    object.renderOrder = 2;
  });
  return axes;
}

const VIEW_TO_SENSOR = BODY_TO_VIEW.clone().invert();
const BODY_SENSOR_IN_VIEW = BODY_TO_VIEW.clone().multiply(SENSOR_TO_BODY).multiply(VIEW_TO_SENSOR);
const FORWARD = new THREE.Vector3(1, 0, 0);

// A gravity-referenced six-axis IMU has no common absolute yaw with the body IMU.
// Match the measured up direction first, then use the model's body heading reference.
export function headCalibrationRotation(sensorRotation, sensorInModel, bodyRotation, result = new THREE.Quaternion()) {
  const modelUp = UP.clone().applyQuaternion(sensorRotation.clone().invert()).applyQuaternion(sensorInModel);
  result.setFromUnitVectors(modelUp.normalize(), UP);
  const from = FORWARD.clone().applyQuaternion(result);
  const to = bodyRotation ? FORWARD.clone().applyQuaternion(bodyRotation) : FORWARD;
  if (Math.hypot(from.x, from.z) > 1e-4 && Math.hypot(to.x, to.z) > 1e-4) {
    const yaw = Math.atan2(to.x * from.z - to.z * from.x, to.x * from.x + to.z * from.z);
    result.premultiply(new THREE.Quaternion().setFromAxisAngle(UP, yaw));
  }
  return result;
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
  const modelRotation = new THREE.Quaternion();
  const jointRotation = new THREE.Quaternion();
  const sensorPosition = new THREE.Vector3();
  const sensorRotation = new THREE.Quaternion();

  function updateScene() {
    const elapsed = elapsedAtUpdate + Math.max(0, performance.now() - receivedAt);
    const live = currentCalibrationPose(source, latest, elapsed, connectionError);
    const calibration = source === 'head' ? latest.head_calibration : latest.calibration;
    const face = suggestedFace(calibration);
    const target = face && tiltForSensorVector(faceVector(face).toArray(), source);
    const headSelected = source === 'head';
    const ready = modelReady && (!headSelected || !!scenes[0].headSensor);
    const bodyHeading = headSelected && imuFresh(latest.imu, latest, elapsed, connectionError)
      ? orientationInView(latest.imu.quaternion_wxyz) : null;
    const servoAgeLimit = latest.individual_device_scan || Number.isFinite(latest.device_report_age_ms)
      ? SERVO_STATUS_MAX_AGE_MS : undefined;
    for (const [index, rotation] of [live.rotation, target].entries()) {
      const stage = scenes[index];
      const visible = !!rotation && ready;
      if (stage.pose.visible !== visible) dirty[index] = true;
      stage.pose.visible = visible;
      if (visible) {
        for (const servo of latest.servos || []) {
          const joint = stage.joints.get(servo.name);
          if (!joint || !Number.isFinite(servo.radians)
            || !deviceFresh(servo, latest, elapsed, connectionError, servoAgeLimit)) continue;
          jointRotation.setFromAxisAngle(joint.axis, servo.radians);
          if (!joint.node.quaternion.equals(jointRotation)) {
            joint.node.quaternion.copy(jointRotation);
            dirty[index] = true;
          }
        }
        modelRotation.copy(rotation);
        const sensor = headSelected ? stage.headSensor : stage.bodySensor;
        if (sensor) {
          // The model is a child of stage.pose, so strip its last displayed rotation.
          const unrotate = stage.pose.quaternion.clone().invert();
          sensor.getWorldPosition(sensorPosition).applyQuaternion(unrotate);
          if (headSelected) {
            // Include the current neck and head joint rotations in the sensor frame.
            sensor.getWorldQuaternion(sensorRotation).premultiply(unrotate)
              .multiply(HEAD_SENSOR_TO_CAD).multiply(VIEW_TO_SENSOR);
            headCalibrationRotation(rotation, sensorRotation, index === 0 ? bodyHeading : null, modelRotation);
          } else {
            sensorRotation.copy(BODY_SENSOR_IN_VIEW);
          }
          if (!stage.axes.visible || !stage.axes.position.equals(sensorPosition)
            || !stage.axes.quaternion.equals(sensorRotation)) {
            stage.axes.visible = true;
            stage.axes.position.copy(sensorPosition);
            stage.axes.quaternion.copy(sensorRotation);
            dirty[index] = true;
          }
        } else if (stage.axes.visible) {
          stage.axes.visible = false;
          dirty[index] = true;
        }
        if (!stage.pose.quaternion.equals(modelRotation)) {
          stage.pose.quaternion.copy(modelRotation);
          dirty[index] = true;
        }
      }
      if (panes[index].dataset.valid !== String(visible)) panes[index].dataset.valid = String(visible);
      const pose = visible ? rotation.toArray().map(value => value.toFixed(6)).join(',') : '';
      if (panes[index].dataset.pose !== pose) panes[index].dataset.pose = pose;
    }
    const liveLabel = live.rotation && !ready ? '模型加载中' : live.detail;
    const targetLabel = face && !ready ? '模型加载中'
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
  function setRobotModel(model, config) {
    const normalized = normalizedModel(model);
    normalized.getObjectByName(config.root_node)?.quaternion.identity();
    const rig = config.head_imu;
    for (const stage of scenes) {
      stage.pose.clear();
      const clone = normalized.clone(true);
      stage.pose.add(clone);
      stage.joints = new Map(config.joints.map(joint => [joint.name, {
        node: clone.getObjectByName(joint.node), axis: new THREE.Vector3(...joint.axis),
      }]));
      stage.bodySensor = clone.getObjectByName(config.root_node)?.getObjectByName('body_imu');
      stage.headSensor = clone.getObjectByName(rig?.head_node)?.getObjectByName(rig?.sensor_node);
      stage.axes = modelSensorAxes();
      stage.pose.add(stage.axes);
    }
    if (!scenes[0].headSensor) onError('模型缺少头部 IMU 节点');
    modelReady = true;
    invalidate();
  }
  return { setActive, setSource, update, setRobotModel, invalidate };
}
