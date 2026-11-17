import * as THREE from 'three';

export function createViewerEnvironment(scene) {
  const platform = new THREE.Group();
  platform.name = 'display-platform';
  platform.position.y = -.07;
  const profile = [[0, -.015], [.096, -.015], [.100, -.014], [.103, -.012],
    [.105, -.009], [.105, -.006], [.103, -.003], [.100, -.001], [.096, 0], [0, 0]]
    .map(([radius, height]) => new THREE.Vector2(radius, height));
  const body = new THREE.Mesh(new THREE.LatheGeometry(profile, 96),
    new THREE.MeshStandardMaterial({ color: '#273536', metalness: .3, roughness: .72 }));
  platform.add(body);
  const rim = new THREE.Mesh(new THREE.TorusGeometry(.104, .0005, 8, 96),
    new THREE.MeshBasicMaterial({ color: '#4d8783', toneMapped: false }));
  rim.rotation.x = Math.PI / 2;
  rim.position.y = -.007;
  platform.add(rim);

  const shadowCanvas = document.createElement('canvas');
  shadowCanvas.width = shadowCanvas.height = 128;
  const context = shadowCanvas.getContext('2d');
  const gradient = context.createRadialGradient(64, 64, 3, 64, 64, 64);
  gradient.addColorStop(0, 'rgba(0, 0, 0, .30)');
  gradient.addColorStop(.45, 'rgba(0, 0, 0, .18)');
  gradient.addColorStop(1, 'rgba(0, 0, 0, 0)');
  context.fillStyle = gradient;
  context.fillRect(0, 0, 128, 128);
  const shadow = new THREE.Mesh(new THREE.PlaneGeometry(.18, .14),
    new THREE.MeshBasicMaterial({ map: new THREE.CanvasTexture(shadowCanvas), transparent: true, depthWrite: false }));
  shadow.rotation.x = -Math.PI / 2;
  shadow.position.y = .0001;
  platform.add(shadow);
  scene.add(platform);
}
