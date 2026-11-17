import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { createViewerEnvironment } from './viewer-environment.js';
import { centerTrunkOnPlatform, createFootHeightAligner, positionForPose } from './ground-placement.js';

export function createActionReferenceView({ viewer, renderer, liveScene, liveCamera, liveControls, onResize }) {
  const panes = document.getElementById('action-pose-views');
  const livePane = document.getElementById('action-live-pane');
  const referencePane = document.getElementById('action-reference-pane');
  const scene = new THREE.Scene();
  createViewerEnvironment(scene);
  scene.add(new THREE.HemisphereLight('#ffffff', '#78887c', 2.8));
  const keyLight = new THREE.DirectionalLight('#fffaf0', 3);
  keyLight.position.set(.6, 1, .5);
  scene.add(keyLight);
  const fillLight = new THREE.DirectionalLight('#e0edff', 1.2);
  fillLight.position.set(-.7, .4, -.6);
  scene.add(fillLight);
  const camera = new THREE.PerspectiveCamera(35, 1, .01, 20);
  const controls = new OrbitControls(camera, referencePane);
  controls.enableDamping = true;
  controls.minDistance = .24;
  controls.maxDistance = 2.5;
  controls.maxPolarAngle = Math.PI * .85;
  controls.disconnect();
  const joints = new Map(), targets = new Map();
  let trunk, modelRoot, alignReferenceFeet, platform, active = false, referenceDirty = true;
  controls.addEventListener('change', () => { referenceDirty = true; });

  function resetView() {
    controls.enableDamping = false;
    controls.update();
    camera.position.set(.45, .28, .48);
    controls.target.set(0, .115, 0);
    controls.update();
    controls.enableDamping = true;
  }
  resetView();

  function applyTargets() {
    for (const [name, raw] of targets) {
      const joint = joints.get(name);
      if (joint) joint.node.quaternion.setFromAxisAngle(joint.axis,
        THREE.MathUtils.degToRad(180 - raw * 360 / 4096));
    }
  }

  function setRobotModel(source, config) {
    const model = source.clone(true);
    modelRoot = model;
    trunk = model.getObjectByName(config.root_node);
    if (!trunk) throw new Error('参考模型缺少机身节点');
    trunk.quaternion.identity();
    for (const joint of config.joints) {
      const node = model.getObjectByName(joint.node);
      if (!node) throw new Error(`参考模型缺少关节 ${joint.name}`);
      joints.set(joint.name, { node, axis: new THREE.Vector3(...joint.axis) });
    }
    scene.add(model);
    const feet = ['left_ankle', 'right_ankle'].map(name => joints.get(name)?.node);
    applyTargets();
    platform = scene.getObjectByName('display-platform');
    model.position.copy(positionForPose(model, [], feet, platform.getWorldPosition(new THREE.Vector3())));
    alignReferenceFeet = createFootHeightAligner(model, feet);
    centerTrunkOnPlatform(model, trunk, platform.getWorldPosition(new THREE.Vector3()));
    referenceDirty = true;
  }

  function setTargets(values, definitions) {
    if (!values || !definitions) return;
    const names = new Map(definitions.map(joint => [joint.id, joint.name]));
    let changed = false;
    for (const [id, raw] of Object.entries(values)) {
      const name = names.get(Number(id));
      if (!name || !Number.isInteger(raw) || targets.get(name) === raw) continue;
      targets.set(name, raw);
      changed = true;
    }
    if (changed) {
      applyTargets();
      if (alignReferenceFeet) {
        const center = platform.getWorldPosition(new THREE.Vector3());
        alignReferenceFeet(center.y);
        centerTrunkOnPlatform(modelRoot, trunk, center);
      }
      referenceDirty = true;
    }
  }

  function setActive(value) {
    if (active === value) return;
    active = value;
    referenceDirty = true;
    panes.hidden = !active;
    liveControls.disconnect();
    liveControls.connect(active ? livePane : renderer.domElement);
    if (active) controls.connect(referencePane); else controls.disconnect();
    onResize();
  }

  function liveSize() {
    return active ? { width: livePane.clientWidth, height: livePane.clientHeight }
      : { width: viewer.clientWidth, height: viewer.clientHeight };
  }

  function resize(configureCamera) {
    if (active) {
      configureCamera(camera, scene, referencePane.clientWidth, referencePane.clientHeight);
      referenceDirty = true;
    }
  }

  function render() {
    if (!active) return false;
    controls.update();
    const bounds = viewer.getBoundingClientRect();
    renderer.setScissorTest(true);
    const views = [[livePane, liveScene, liveCamera]];
    if (referenceDirty) views.push([referencePane, scene, camera]);
    for (const [pane, viewScene, viewCamera] of views) {
      const rect = pane.getBoundingClientRect();
      const x = rect.left - bounds.left, y = bounds.bottom - rect.bottom;
      renderer.setViewport(x, y, rect.width, rect.height);
      renderer.setScissor(x, y, rect.width, rect.height);
      renderer.render(viewScene, viewCamera);
    }
    referenceDirty = false;
    renderer.setScissorTest(false);
    return true;
  }

  const invalidate = () => { referenceDirty = true; };
  return { setRobotModel, setTargets, setActive, liveSize, resize, render, resetView,
    invalidate };
}
