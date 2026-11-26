"""Regenerate the Studio rig from a WonderDuck RL model directory.

Run with the directory containing mujoco/robot.xml and meshes/.
Import the original display OBJ triangles and vertex normals at full resolution.
The current Studio model supplies the servo home pose and palette.
"""

import argparse
import hashlib
import json
from pathlib import Path
import struct
import xml.etree.ElementTree as ET

import numpy as np

WEB = Path(__file__).resolve().parents[1] / 'web'
HOME_MODEL = WEB / 'public/assets/imu-viewer-resources'
JSON_CHUNK = 0x4E4F534A
BINARY_CHUNK = 0x004E4942

MODEL_ATTRIBUTION = {
    'extras': {
        'title': 'WonderDuck robot 3D model',
        'license': 'CC-BY-NC-SA-4.0',
        'licenseUrl': 'https://creativecommons.org/licenses/by-nc-sa/4.0/legalcode',
        'source': 'WonderDuck RL display meshes',
        'modifications': (
            'Studio converts the WonderDuck RL display meshes from OBJ to glTF (GLB) '
            'and integrates servo and head IMU nodes.'
        ),
    },
}


def load_glb(path):
    raw = path.read_bytes()
    magic, version, size, json_size, kind = struct.unpack_from('<4s4I', raw)
    if (magic, version, size, kind) != (b'glTF', 2, len(raw), JSON_CHUNK):
        raise ValueError(f'Invalid GLB: {path}')
    end = 20 + json_size
    binary_size, kind = struct.unpack_from('<2I', raw, end)
    if kind != BINARY_CHUNK or end + 8 + binary_size != len(raw):
        raise ValueError(f'Invalid GLB binary chunk: {path}')
    return json.loads(raw[20:end]), memoryview(raw)[end + 8:]


def quaternion(wxyz):
    w, x, y, z = wxyz
    return [x, y, z, w]


def local_rotation(xyzw):
    x, y, z, w = np.asarray(xyzw) / np.linalg.norm(xyzw)
    return np.array((
        (1 - 2 * (y*y + z*z), 2 * (x*y - z*w), 2 * (x*z + y*w)),
        (2 * (x*y + z*w), 1 - 2 * (x*x + z*z), 2 * (y*z - x*w)),
        (2 * (x*z - y*w), 2 * (y*z + x*w), 1 - 2 * (x*x + y*y)),
    ))


def glb_bytes(rig, binary):
    encoded = json.dumps(rig, separators=(',', ':')).encode()
    encoded += b' ' * (-len(encoded) % 4)
    binary.extend(b'\0' * (-len(binary) % 4))
    return (struct.pack('<4s4I', b'glTF', 2, 28 + len(encoded) + len(binary), len(encoded), JSON_CHUNK)
            + encoded + struct.pack('<2I', len(binary), BINARY_CHUNK) + binary)


def read_obj(path):
    """One glTF vertex per unique OBJ position/normal pair, preserving hard edges."""
    positions, normals, corners = [], [], []
    with path.open() as source:
        for line in source:
            if line.startswith('v '):
                positions.append(tuple(map(float, line.split()[1:4])))
            elif line.startswith('vn '):
                normals.append(tuple(map(float, line.split()[1:4])))
            elif line.startswith('f '):
                face = line.split()[1:]
                if len(face) != 3:
                    raise ValueError(f'Non-triangular OBJ face: {path}')
                for vertex in face:
                    position, _, normal = vertex.split('/')
                    corners.append((int(position), int(normal)))

    pairs, indices = np.unique(np.asarray(corners, dtype=np.int32), axis=0, return_inverse=True)
    if not len(pairs) or pairs.min() < 1 or pairs[:, 0].max() > len(positions) or pairs[:, 1].max() > len(normals):
        raise ValueError(f'Invalid OBJ vertex or normal index: {path}')
    points = np.asarray(positions, dtype='<f4')[pairs[:, 0] - 1]
    normals = np.asarray(normals, dtype='<f4')[pairs[:, 1] - 1]
    if not np.isfinite(points).all() or not np.isfinite(normals).all():
        raise ValueError(f'Non-finite OBJ data: {path}')
    packed_normals = np.zeros((len(normals), 4), dtype='<i2')
    packed_normals[:, :3] = np.rint(np.clip(normals, -1, 1) * 32767).astype('<i2')
    indices = indices.astype('<u2' if len(points) <= 65536 else '<u4')
    return points, packed_normals, indices


def sync(source, revision):
    model_xml = source / 'mujoco/robot.xml'
    xml = ET.parse(model_xml)
    mesh_dir = model_xml.parent / xml.find('compiler').attrib['meshdir']
    assets = {mesh.attrib['name']: mesh for mesh in xml.find('asset').findall('mesh')}
    config_file = HOME_MODEL / 'attitude-model.json'
    config = json.loads(config_file.read_text())
    original, _ = load_glb(HOME_MODEL / config['model'])
    home = {node['name']: node for node in original['nodes']}
    joint_specs = {joint['name']: joint for joint in config['joints']}
    materials = original['materials']
    material_ids = {material['name']: index for index, material in enumerate(materials)}
    rig = dict(asset=dict(version='2.0', generator='Studio viewer model import', **MODEL_ATTRIBUTION),
               scene=0, scenes=[dict(nodes=[0])], nodes=[], meshes=[], materials=materials,
               accessors=[], bufferViews=[], buffers=[], extensionsUsed=['KHR_mesh_quantization'],
               extensionsRequired=['KHR_mesh_quantization'])
    binary = bytearray()
    triangle_count = 0
    lowest = float('inf')
    joints_seen = set()

    def add_node(name, parent=None, **properties):
        node_id = len(rig['nodes'])
        rig['nodes'].append(dict(name=name, **properties))
        if parent is not None:
            rig['nodes'][parent].setdefault('children', []).append(node_id)
        return node_id

    def add_accessor(data, component, kind, target, **options):
        binary.extend(b'\0' * (-len(binary) % 4))
        view = dict(buffer=0, byteOffset=len(binary), byteLength=data.nbytes, target=target)
        stride = options.pop('stride', None)
        if stride is not None:
            view['byteStride'] = stride
        accessor_id = len(rig['accessors'])
        rig['accessors'].append(dict(componentType=component, type=kind, count=len(data),
                                     bufferView=len(rig['bufferViews']), **options))
        rig['bufferViews'].append(view)
        binary.extend(data.tobytes())
        return accessor_id

    def import_mesh(geom, frame, body_rotation, body_position):
        nonlocal lowest, triangle_count
        name = geom.attrib['name']
        asset = assets[geom.attrib['mesh']]
        mesh_path = mesh_dir / asset.attrib['file']
        if mesh_path.suffix.lower() != '.obj':
            raise ValueError(f'Expected a display OBJ: {mesh_path}')
        points, normals, indices = read_obj(mesh_path)
        material_name = geom.attrib['material'].split('display_', 1)[-1]
        if name == 'visual_p_head_roll_01':
            material_name = 'body_black'  # Keep the front plate black in both palettes.
        position = list(map(float, geom.get('pos', '0 0 0').split()))
        rotation = quaternion(list(map(float, geom.get('quat', '1 0 0 0').split())))
        scale = list(map(float, asset.get('scale', '1 1 1').split()))
        world_rotation = body_rotation @ local_rotation(rotation)
        world_position = body_position + body_rotation @ np.array(position)
        lowest = min(lowest, float((points @ (world_rotation[2] * scale) + world_position[2]).min()))
        attributes = {
            'POSITION': add_accessor(points, 5126, 'VEC3', 34962,
                                     min=points.min(axis=0).tolist(), max=points.max(axis=0).tolist()),
            'NORMAL': add_accessor(normals, 5122, 'VEC3', 34962, normalized=True, stride=8),
        }
        index_accessor = add_accessor(indices, 5123 if indices.dtype.itemsize == 2 else 5125, 'SCALAR', 34963)
        add_node(name, frame, mesh=len(rig['meshes']), rotation=rotation, translation=position, scale=scale)
        rig['meshes'].append(dict(name=name, primitives=[dict(
            attributes=attributes, indices=index_accessor, material=material_ids[material_name], mode=4)]))
        triangle_count += len(indices) // 3

    def add_body(body, parent, parent_rotation, parent_position):
        name = body.attrib['name']
        position = [0, 0, 0] if name == 'trunk_base' else list(map(float, body.get('pos', '0 0 0').split()))
        fixed = quaternion(list(map(float, body.get('quat', '1 0 0 0').split())))
        frame = add_node('origin_' + name, parent, translation=position, rotation=fixed)
        body_rotation = parent_rotation @ local_rotation(fixed)
        body_position = parent_position + parent_rotation @ np.array(position)
        joint = body.find('joint')
        # The display rig gives the physical beak servo a joint even when MJCF freezes it.
        joint_name = joint.get('name') if joint is not None else 'mouth' if name == 'mouth' else None
        if joint_name in joint_specs:
            spec = joint_specs[joint_name]
            if joint is not None:
                axis = list(map(float, joint.get('axis', '0 0 1').split()))
                if not np.allclose(axis, spec['axis']):
                    raise ValueError(f'Joint axis changed: {joint_name}')
            motion = home[spec['node']]['rotation']
            frame = add_node(spec['node'], frame, rotation=motion)
            body_rotation = body_rotation @ local_rotation(motion)
            joints_seen.add(joint_name)
        frame = add_node('body_' + name, frame)
        for geom in body.findall('geom'):
            if geom.get('group') == '2':
                import_mesh(geom, frame, body_rotation, body_position)
        for child in body.findall('body'):
            add_body(child, frame, body_rotation, body_position)

    add_node('world_y_up', rotation=home['world_y_up']['rotation'])
    add_body(xml.find('worldbody/body'), 0, np.eye(3), np.zeros(3))
    names = {node['name'] for node in rig['nodes']}
    if joints_seen != joint_specs.keys() or not {'body_head_roll', 'body_head_imu'} <= names or not np.isfinite(lowest):
        raise ValueError('Incomplete Studio model')
    rig['buffers'].append(dict(byteLength=len(binary)))
    model = glb_bytes(rig, binary)
    digest = hashlib.sha256(model).hexdigest()
    filename = f'robot-{digest[:12]}.glb'
    (HOME_MODEL / filename).write_bytes(model)
    config.update(model=filename, home_trunk_height_m=-lowest,
                  head_imu=dict(head_node='body_head_roll', sensor_node='body_head_imu'),
                  source_revision=revision, triangles=triangle_count,
                  source_xml_sha256=hashlib.sha256(model_xml.read_bytes()).hexdigest())
    config_file.write_text(json.dumps(config, indent=2) + '\n')
    version = hashlib.sha256(config_file.read_bytes()).hexdigest()[:16]
    (WEB / 'src/model-resource.js').write_text(
        '// Generated by console/tools/sync_viewer_model.py.\n'
        f"export const modelConfigUrl = '/assets/imu-viewer-resources/attitude-model.json?v={version}';\n")
    print(f'{filename} · {len(rig["meshes"])} meshes · {triangle_count:,} triangles · {len(model):,} bytes')


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('source', type=Path)
    parser.add_argument('--revision', required=True)
    args = parser.parse_args()
    sync(args.source, args.revision)
