// A servo's model parts belong to its nearest joint, not descendant joints.
const ISSUE_KINDS = new Set(['fault', 'offline', 'timeout', 'communication', 'invalid', 'stale', 'configuration']);

export function createJointHighlighter() {
  const groups = new Map();
  const issues = new Set();
  let applied = new Map();
  let workspace = '', selected = [], joints = [];

  function refresh() {
    const names = new Map(joints.map(joint => [joint.id, joint.name]));
    const ids = workspace === 'status' ? issues : selected;
    const mode = workspace === 'status' ? 'fault' : 'selected';
    const next = new Map();
    for (const id of ids) {
      const group = groups.get(names.get(id));
      if (group) next.set(group, mode);
    }
    for (const [group, previous] of applied) {
      if (next.get(group) !== previous) {
        for (const visual of group.visuals) visual.mesh.material = visual.original;
      }
    }
    for (const [group, current] of next) {
      if (applied.get(group) !== current) {
        for (const visual of group.visuals) visual.mesh.material = visual[current];
      }
    }
    applied = next;
  }

  function setContext(page, selection, definitions) {
    if (workspace === 'status' && page !== 'status') issues.clear();
    workspace = page;
    selected = selection;
    joints = definitions;
    refresh();
  }

  function setStatuses(statuses) {
    for (const [id, kind] of statuses) {
      if (ISSUE_KINDS.has(kind)) issues.add(id);
      else if (kind === 'normal') issues.delete(id);
      // An interrupted connection or pending read is not proof of recovery.
    }
    refresh();
  }

  function prepare(model, rigJoints) {
    groups.clear();
    applied = new Map();
    const owners = new Map();
    for (const [name, joint] of rigJoints) {
      const group = { visuals: [] };
      groups.set(name, group);
      owners.set(joint.node, group);
    }
    const mouth = model.getObjectByName('body_mouth');
    if (mouth && !rigJoints.has('mouth')) {
      const group = { visuals: [] };
      groups.set('mouth', group);
      owners.set(mouth, group);
    }
    model.traverse(mesh => {
      if (!mesh.isMesh) return;
      let parent = mesh.parent;
      while (parent && !owners.has(parent)) parent = parent.parent;
      const group = owners.get(parent);
      if (!group) return;
      const makeMaterial = (original, color, glow) => {
        const material = original.clone();
        material.color.set(color);
        if (material.emissive) { material.emissive.set(glow); material.emissiveIntensity = .4; }
        material.toneMapped = false;
        return material;
      };
      const original = mesh.material;
      const make = (color, glow) => Array.isArray(original)
        ? original.map(material => makeMaterial(material, color, glow)) : makeMaterial(original, color, glow);
      group.visuals.push({ mesh, original, selected: make('#32b83c', '#105910'), fault: make('#ed3030', '#620606') });
    });
    refresh();
  }

  return { prepare, setContext, setStatuses, hasIssues: () => issues.size > 0 };
}
