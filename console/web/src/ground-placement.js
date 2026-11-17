import { Vector3 } from 'three';

// Keep the trunk origin over the platform while preserving the current floor height.
export function centerTrunkOnPlatform(root, trunk, center) {
  if (!root?.parent || !trunk || !center || ![center.x, center.z].every(Number.isFinite)) {
    throw new Error('模型居中需要躯干和有效展示台中心');
  }
  root.updateWorldMatrix(true, true);
  const rootWorld = root.getWorldPosition(new Vector3());
  const trunkWorld = trunk.getWorldPosition(new Vector3());
  rootWorld.x += center.x - trunkWorld.x;
  rootWorld.z += center.z - trunkWorld.z;
  root.position.copy(root.parent.worldToLocal(rootWorld));
  root.updateWorldMatrix(true, true);
}

// Place the lowest actual foot surface on the floor at the displayed pose.
// Uneven feet retain their relative height; rotations and servo targets stay intact.
export function placeFeetOnGround(root, feet, groundY = 0, center = null) {
  if (!root?.parent || feet.length !== 2 || !Number.isFinite(groundY)) {
    throw new Error('脚贴地需要完整模型、双脚和有效地板高度');
  }
  root.updateWorldMatrix(true, true);
  const point = new Vector3();
  const min = new Vector3(Infinity, Infinity, Infinity);
  const max = new Vector3(-Infinity, -Infinity, -Infinity);
  for (const foot of feet) {
    let vertices = 0;
    foot.traverse(mesh => {
      if (!mesh.isMesh) return;
      const positions = mesh.geometry.getAttribute('position');
      for (let index = 0; index < positions.count; index++) {
        point.fromBufferAttribute(positions, index).applyMatrix4(mesh.matrixWorld);
        min.min(point);
        max.max(point);
      }
      vertices += positions.count;
    });
    if (!vertices) throw new Error('脚部缺少可用于贴地的表面网格');
  }
  if (!Number.isFinite(min.y)) throw new Error('脚部高度无效');
  const world = root.getWorldPosition(new Vector3());
  world.y += groundY - min.y;
  if (center) {
    world.x += center.x - (min.x + max.x) / 2;
    world.z += center.z - (min.z + max.z) / 2;
  }
  root.position.copy(root.parent.worldToLocal(world));
  root.updateWorldMatrix(true, true);
  return groundY - min.y;
}

// Align height to the displayed pose, reusing each rigid mesh's support height
// while its orientation and position relative to the root stay unchanged.
export function createFootHeightAligner(root, feet) {
  if (!root?.parent || feet.length !== 2 || feet.some(foot => !foot)) {
    throw new Error('脚贴地需要完整模型和双脚');
  }
  const meshes = [];
  for (const foot of feet) {
    let count = 0;
    foot.traverse(mesh => {
      const positions = mesh.isMesh && mesh.geometry.getAttribute('position');
      if (!positions?.count) return;
      meshes.push({ mesh, positions, coefficients: null, minimum: Infinity });
      count += positions.count;
    });
    if (!count) throw new Error('脚部缺少可用于贴地的表面网格');
  }
  const world = new Vector3();
  return groundY => {
    if (!Number.isFinite(groundY)) throw new Error('地板高度无效');
    root.getWorldPosition(world);
    let lowest = Infinity;
    for (const entry of meshes) {
      entry.mesh.updateWorldMatrix(true, false);
      const matrix = entry.mesh.matrixWorld.elements;
      const coefficients = [matrix[1], matrix[5], matrix[9], matrix[13] - world.y];
      if (!entry.coefficients || coefficients.some((value, i) => Math.abs(value - entry.coefficients[i]) > 1e-10)) {
        const positions = entry.positions;
        let minimum = Infinity;
        if (positions.isBufferAttribute && !positions.normalized && positions.itemSize === 3) {
          const values = positions.array;
          for (let i = 0; i < values.length; i += 3) {
            minimum = Math.min(minimum, values[i] * coefficients[0] + values[i + 1] * coefficients[1]
              + values[i + 2] * coefficients[2] + coefficients[3]);
          }
        } else {
          for (let i = 0; i < positions.count; i++) {
            minimum = Math.min(minimum, positions.getX(i) * coefficients[0] + positions.getY(i) * coefficients[1]
              + positions.getZ(i) * coefficients[2] + coefficients[3]);
          }
        }
        entry.coefficients = coefficients;
        entry.minimum = minimum;
      }
      lowest = Math.min(lowest, entry.minimum);
    }
    if (!Number.isFinite(lowest)) throw new Error('脚部高度无效');
    const adjustment = groundY - (world.y + lowest);
    world.y += adjustment;
    root.position.copy(root.parent.worldToLocal(world));
    return adjustment;
  };
}

export function positionForPose(root, poses, feet, platformCenter) {
  const originalPosition = root.position.clone();
  const rotations = poses.map(({ node }) => [node, node.quaternion.clone()]);
  try {
    for (const { node, rotation } of poses) node.quaternion.copy(rotation);
    placeFeetOnGround(root, feet, platformCenter.y, platformCenter);
    return root.position.clone();
  } finally {
    root.position.copy(originalPosition);
    for (const [node, rotation] of rotations) node.quaternion.copy(rotation);
    root.updateWorldMatrix(true, true);
  }
}
