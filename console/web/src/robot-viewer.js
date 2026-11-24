import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { modelConfigUrl } from './model-resource.js';
import { createViewerEnvironment } from './viewer-environment.js';
import { createModelPaletteControl } from './model-palette.js';
import { centerTrunkOnPlatform, createFootHeightAligner, positionForPose } from './ground-placement.js';
import { createActionReferenceView } from './action-reference-view.js';
import { createJointHighlighter } from './joint-highlights.js';
import { setLocalizedText } from '../../../webpadd/web/language.js';

export function createRobotViewer({ request, toast, context }) {
  const $ = id => document.getElementById(id);
  const viewer = $('viewer');
  let calibrationView, calibrationViewLoad;
  let page = '';
  let frame = 0, lastFrame = 0;
  let latestPose = null;
  let calibrationSource = 'body';
  let calibrationSnapshot = null;
  let calibrationVisible = false;
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(35, 1, .01, 20);
  let renderer, controls, trunk, modelRoot, modelPositionTarget, pendingPoseTargets, referenceView;
  let alignLiveFeet, modelPlatform;
  let modelAsset, modelPlacementReady = false;
  const modelPlacementKey = 'console-model-placement';
  const rigJoints = new Map();
  const jointHighlighter = createJointHighlighter();
  const attitudeTarget = new THREE.Quaternion();
  function saveModelPlacement(platform) {
    try {
      const offset = modelPositionTarget.clone().sub(platform.position).toArray();
      localStorage.setItem(modelPlacementKey, JSON.stringify({ model: modelAsset, offset }));
    } catch (error) {
      console.error('模型位置保存失败', error);
      toast('模型位置未能保存，刷新后可能需要重新对齐', true);
    }
  }
  function restoreModelPlacement(platform) {
    try {
      const value = localStorage.getItem(modelPlacementKey);
      if (!value) return;
      const saved = JSON.parse(value);
      if (saved.model !== modelAsset) return;
      if (!Array.isArray(saved.offset) || saved.offset.length !== 3 || !saved.offset.every(Number.isFinite)) {
        throw new Error('保存的模型位置无效');
      }
      modelPositionTarget = new THREE.Vector3(...saved.offset).add(platform.position);
      modelRoot.position.copy(modelPositionTarget);
      modelPlacementReady = true;
    } catch (error) {
      console.error('模型位置恢复失败', error);
      toast('无法恢复保存的模型位置', true);
    }
  }
  function initializeModelPlacement() {
    if (modelPlacementReady || !modelRoot || !trunk) return;
    const feet = ['left_ankle', 'right_ankle'].map(name => rigJoints.get(name)?.node);
    if (!modelPlatform || feet.some(foot => !foot)) return;
    modelPositionTarget = positionForPose(modelRoot, [], feet, modelPlatform.getWorldPosition(new THREE.Vector3()));
    modelRoot.position.copy(modelPositionTarget);
    modelPlacementReady = true;
  }
  function alignPoseToPlatform(targets) {
    modelPlacementReady = true;
    pendingPoseTargets = targets;
    if (!modelRoot || !trunk) return;
    try {
      const feet = ['left_ankle', 'right_ankle'].map(name => rigJoints.get(name)?.node);
      const platform = scene.getObjectByName('display-platform');
      if (!platform || feet.some(foot => !foot)) throw new Error('模型缺少双脚或展示台');
      const poses = [];
      for (const [id, raw] of Object.entries(targets)) {
        const name = context().joints.find(joint => joint.id === Number(id))?.name;
        const joint = rigJoints.get(name);
        if (joint) poses.push({ node: joint.node, rotation: new THREE.Quaternion().setFromAxisAngle(
          joint.axis, THREE.MathUtils.degToRad(180 - raw * 360 / 4096)) });
      }
      modelPositionTarget = positionForPose(modelRoot, poses, feet, platform.getWorldPosition(new THREE.Vector3()));
      saveModelPlacement(platform);
      pendingPoseTargets = null;
    } catch (error) {
      console.error('模型贴合失败', error);
      toast(`目标已下发，模型贴合失败：${error.message}`, true);
    }
  }
  $('model-imu-follow').addEventListener('change', event => {
    if (!event.target.checked && trunk) trunk.quaternion.identity();
  });

  const modelPaletteMaterials = new Map();
  const modelPalettes = {
    white_orange: { body_deep_blue: '#f2f2f2', body_yellow: '#f28c28', body_foot: '#f28c28', body_mouth: '#f28c28', body_black: '#424548' },
    yellow_black: { body_deep_blue: '#ffcf29', body_yellow: '#424548', body_foot: '#ffcf29', body_mouth: '#424548', body_black: '#424548' },
    black_orange: { body_deep_blue: '#424548', body_yellow: '#f28c28', body_foot: '#f28c28', body_mouth: '#f28c28', body_black: '#424548' },
    navy: { body_deep_blue: '#102c60', body_yellow: '#ffcf29', body_foot: '#ffcf29', body_mouth: '#ffcf29', body_black: '#424548' },
  };
  const separatePaletteVisuals = new Map([
    ['visual_p_left_ankle_01', 'body_foot'],
    ['visual_p_right_ankle_01', 'body_foot'],
    ['visual_p_mouth_01', 'body_mouth'],
  ]);

  function applyModelPalette() {
    const palette = modelPalettes[$('model-palette').value];
    for (const [material, originalColor] of modelPaletteMaterials) {
      const color = palette[material.name];
      if (color === null) material.color.copy(originalColor);
      else material.color.set(color);
    }
    referenceView?.invalidate();
    calibrationView?.invalidate();
  }
  const paletteControl = createModelPaletteControl({
    select: $('model-palette'),
    valid: value => typeof value === 'string' && Object.hasOwn(modelPalettes, value),
    apply: applyModelPalette,
    request,
    onError: error => toast(`模型配色保存失败：${error.message}`, true),
    onLoadError: error => console.warn('读取模型配色失败', error.message),
  });
  paletteControl.load();

  function highlightSelectedJoints() {
    const { selected, joints } = context();
    jointHighlighter.setContext(page, selected, joints);
    $('model-servo-alert').hidden = page !== 'status' || !jointHighlighter.hasIssues();
  }

  function prepareJointHighlights(model) {
    jointHighlighter.prepare(model, rigJoints);
    highlightSelectedJoints();
  }

  createViewerEnvironment(scene);
  scene.add(new THREE.HemisphereLight('#ffffff', '#78887c', 2.8));
  const keyLight = new THREE.DirectionalLight('#fffaf0', 3); keyLight.position.set(.6, 1, .5); scene.add(keyLight);
  const fillLight = new THREE.DirectionalLight('#e0edff', 1.2); fillLight.position.set(-.7, .4, -.6); scene.add(fillLight);
  try {
    try {
      renderer = new THREE.WebGLRenderer({ alpha: true, antialias: true, powerPreference: 'low-power', preserveDrawingBuffer: true });
    } catch (error) {
      console.warn('3D 初始化失败，正在使用兼容设置重试', error);
      renderer = new THREE.WebGLRenderer({ alpha: true, antialias: false, preserveDrawingBuffer: true });
    }
    renderer.setClearColor(0x000000, 0);
    renderer.setPixelRatio(Math.min(devicePixelRatio, 1.5));
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.1;
    viewer.append(renderer.domElement);
    controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true; controls.minDistance = .24; controls.maxDistance = 2.5;
    controls.maxPolarAngle = Math.PI * .85;
    renderer.domElement.addEventListener('webglcontextlost', event => {
      event.preventDefault();
      $('model-loading').hidden = false;
      reportModelError('3D 显示已中断，正在恢复');
    });
    renderer.domElement.addEventListener('webglcontextrestored', () => {
      $('model-loading').hidden = !!modelRoot;
      calibrationView?.invalidate();
      referenceView?.invalidate();
      resizeViewer();
    });
  } catch (e) {
    console.error('3D 初始化失败', e);
    renderer?.dispose();
    renderer?.domElement.remove();
    renderer = controls = undefined;
    reportModelError('无法初始化 3D 显示，请检查浏览器 WebGL 2 支持');
  }

  if (renderer) {
    referenceView = createActionReferenceView({ viewer, renderer, liveScene: scene, liveCamera: camera,
      liveControls: controls, onResize: resizeViewer });
  }
  function updateReferenceView() {
    referenceView?.setActive(page === 'action' && $('reference-pose').checked);
  }
  $('reference-pose').addEventListener('change', updateReferenceView);

  function resetView() {
    if (controls) { controls.enableDamping = false; controls.update(); }
    camera.position.set(.45, .28, .48);
    controls?.target.set(0, .115, 0);
    controls?.update();
    if (controls) controls.enableDamping = true;
    referenceView?.resetView();
    const size = referenceView?.liveSize() || { width: viewer.clientWidth, height: viewer.clientHeight };
    configureViewerCamera(camera, scene, size.width, size.height);
    referenceView?.resize(configureViewerCamera);
  }
  function framePlatform(viewCamera, viewScene, width, height) {
    const platform = viewScene.getObjectByName('display-platform');
    if (!width || !height || !platform) return;
    viewCamera.clearViewOffset();
    viewCamera.updateMatrixWorld();
    const center = platform.getWorldPosition(new THREE.Vector3()).project(viewCamera);
    if (!Number.isFinite(center.y)) return;
    const offsetY = ((1 - center.y) / 2 - 3 / 4) * height;
    viewCamera.setViewOffset(width, height, 0, offsetY, width, height);
  }
  function configureViewerCamera(viewCamera, viewScene, width, height) {
    if (!width || !height) return;
    viewCamera.aspect = width / height;
    viewCamera.fov = THREE.MathUtils.radToDeg(2 * Math.atan(Math.tan(THREE.MathUtils.degToRad(35) / 2)
      * Math.max(1, .78 / viewCamera.aspect)));
    framePlatform(viewCamera, viewScene, width, height);
  }
  function renderViewer() {
    if (referenceView?.render()) return;
    renderer.setScissorTest(false);
    renderer.setViewport(0, 0, viewer.clientWidth, viewer.clientHeight);
    renderer.render(scene, camera);
  }
  function resizeViewer() {
    if (!renderer || !viewer.clientWidth || page === 'calibration') return;
    const height = Math.max(1, viewer.clientHeight);
    renderer.domElement.style.top = '0';
    renderer.domElement.style.height = `${height}px`;
    const size = referenceView?.liveSize() || { width: viewer.clientWidth, height };
    configureViewerCamera(camera, scene, size.width, size.height);
    referenceView?.resize(configureViewerCamera);
    renderer.setSize(viewer.clientWidth, height, false);
    renderViewer();
  }
  new ResizeObserver(resizeViewer).observe(viewer);
  $('reset-view').addEventListener('click', resetView);

  async function loadModel() {
    if (!renderer) return;
    try {
      const response = await fetch(modelConfigUrl);
      if (!response.ok) throw new Error('模型配置读取失败');
      const config = await response.json();
      const gltf = await new GLTFLoader().loadAsync(`/assets/imu-viewer-resources/${config.model}`);
      modelAsset = config.model;
      modelRoot = gltf.scene;
      trunk = gltf.scene.getObjectByName(config.root_node);
      if (!trunk) throw new Error('模型缺少机身节点');
      gltf.scene.position.y = config.home_trunk_height_m;
      scene.add(gltf.scene);
      for (const joint of config.joints) {
        const node = gltf.scene.getObjectByName(joint.node);
        if (!node) throw new Error(`模型缺少关节 ${joint.name}`);
        rigJoints.set(joint.name, { node, axis: new THREE.Vector3(...joint.axis), target: node.quaternion.clone() });
      }
      modelPlatform = scene.getObjectByName('display-platform');
      alignLiveFeet = createFootHeightAligner(modelRoot,
        ['left_ankle', 'right_ankle'].map(name => rigJoints.get(name)?.node));
      gltf.scene.traverse(mesh => {
        if (!mesh.isMesh) return;
        const paletteName = separatePaletteVisuals.get(mesh.name);
        if (paletteName) {
          // Feet and mouth share the body material in the model; color them independently.
          const separateMaterial = material => {
            if (material.name !== 'body_yellow') return material;
            const separate = material.clone();
            separate.name = paletteName;
            return separate;
          };
          mesh.material = Array.isArray(mesh.material)
            ? mesh.material.map(separateMaterial) : separateMaterial(mesh.material);
        }
        for (const material of Array.isArray(mesh.material) ? mesh.material : [mesh.material]) {
          if (Object.hasOwn(modelPalettes.navy, material.name)) modelPaletteMaterials.set(material, material.color.clone());
        }
      });
      applyModelPalette();
      referenceView?.setRobotModel(gltf.scene, config);
      prepareJointHighlights(gltf.scene);
      calibrationView?.setRobotModel(gltf.scene);
      if (latestPose) updatePose(latestPose);
      if (pendingPoseTargets) alignPoseToPlatform(pendingPoseTargets);
      else {
        restoreModelPlacement(scene.getObjectByName('display-platform'));
        initializeModelPlacement();
      }
      const center = modelPlatform.getWorldPosition(new THREE.Vector3());
      alignLiveFeet(center.y);
      centerTrunkOnPlatform(modelRoot, trunk, center);
      if (modelPositionTarget) modelPositionTarget.copy(modelRoot.position);
      $('model-loading').hidden = true;
      resetView(); resizeViewer();
    } catch (error) {
      reportModelError(`模型加载失败：${error.message}`);
    }
  }

  function animate(now) {
    frame = requestAnimationFrame(animate);
    if (document.hidden || now - lastFrame < 1000 / 30) return;
    const { cameraExpanded, imuIsFresh, servoIsFresh } = context();
    if (cameraExpanded) return;
    const dt = Math.min(.1, (now - lastFrame) / 1000); lastFrame = now;
    if (trunk) {
      const fraction = 1 - Math.exp(-22 * dt);
      if (modelPositionTarget) modelRoot.position.lerp(modelPositionTarget, fraction);
      if (!$('model-imu-follow').checked) trunk.quaternion.identity();
      else if (imuIsFresh()) trunk.quaternion.slerp(attitudeTarget, fraction);
      for (const servo of latestPose?.servos || []) {
        const joint = rigJoints.get(servo.name);
        if (joint && servoIsFresh(servo)) joint.node.quaternion.slerp(joint.target, fraction);
      }
      if (alignLiveFeet && modelPlatform) {
        const center = modelPlatform.getWorldPosition(new THREE.Vector3());
        alignLiveFeet(center.y);
        centerTrunkOnPlatform(modelRoot, trunk, center);
        if (modelPositionTarget) modelPositionTarget.copy(modelRoot.position);
      }
    }
    controls?.update();
    renderViewer();
  }

  function reportModelError(message) {
    setLocalizedText($('model-loading'), message);
    toast(message, true);
  }

  function updatePose(pose) {
    latestPose = pose;
    const { servoIsFresh } = context();
    if (pose.quaternion) {
      const [w, x, y, z] = pose.quaternion;
      attitudeTarget.set(x, y, z, w).normalize();
    }
    for (const servo of pose.servos) {
      const joint = rigJoints.get(servo.name);
      if (joint && servoIsFresh(servo) && Number.isFinite(servo.radians)) {
        joint.target.setFromAxisAngle(joint.axis, servo.radians);
      }
    }
    if (pose.fresh) initializeModelPlacement();
  }

  function updateStatuses(statuses) {
    jointHighlighter.setStatuses(statuses);
    highlightSelectedJoints();
  }

  function setPage(value) {
    page = value;
    highlightSelectedJoints();
    updateReferenceView();
    const animateViewer = renderer && ['action', 'status', 'debug'].includes(page);
    if (animateViewer && !frame) {
      frame = requestAnimationFrame(animate);
    } else if (!animateViewer && frame) {
      cancelAnimationFrame(frame);
      frame = 0;
    }
    resizeViewer();
  }

  function setCalibrationVisible(value) {
    calibrationVisible = value;
    if (calibrationView) {
      calibrationView.setActive(value);
      return;
    }
    if (!value || calibrationViewLoad) return;
    calibrationViewLoad = import('./calibration-view.js').then(({ createCalibrationView }) => {
      calibrationView = createCalibrationView({ viewer, renderer, onError: message => toast(message, true), onRelease: resizeViewer });
      calibrationView.setSource(calibrationSource);
      if (calibrationSnapshot) calibrationView.update(...calibrationSnapshot);
      if (modelRoot) calibrationView.setRobotModel(modelRoot);
      calibrationView.setActive(calibrationVisible);
    }).catch(error => {
      console.error('加载校准视图失败', error);
      toast(`校准视图加载失败：${error.message}`, true);
    }).finally(() => { calibrationViewLoad = null; });
  }

  function updateCalibration(source, snapshot) {
    if (source !== calibrationSource) {
      calibrationSource = source;
      calibrationView?.setSource(source);
    }
    if (snapshot) {
      calibrationSnapshot = snapshot;
      calibrationView?.update(...snapshot);
    }
  }

  loadModel();
  return {
    alignPoseToPlatform, setPage, updatePose, updateStatuses, setCalibrationVisible, updateCalibration,
    updateSelection: highlightSelectedJoints,
    updateReferenceTargets: (targets, joints) => referenceView?.setTargets(targets, joints),
  };
}
