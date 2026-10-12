"""Independent generic #116 consumer. Accept only actual production-export bytes.

Blender5.0.1 background: --python this.py -- --glb output.glb --checker oracle.png --report report.json
World bounds are hand-authored from the source triangle/parent90-degreeZ/TRS,
then canonical Y-up→Blender Z-up: (x,y,z)→(x,-z,y).
"""
import argparse
import json
import sys
import traceback
from pathlib import Path
import bpy
from mathutils import Vector


def close(a, b):
    assert len(a) == len(b) and all(abs(x-y)<1e-5 for x,y in zip(a,b)), (list(a),list(b))


def bounds(obj):
    points=[obj.matrix_world @ v.co for v in obj.data.vertices]
    return [min(p[i] for p in points) for i in range(3)], [max(p[i] for p in points) for i in range(3)]


def main():
    p=argparse.ArgumentParser()
    p.add_argument('--glb',required=True);p.add_argument('--checker',required=True);p.add_argument('--report',required=True)
    a=p.parse_args(sys.argv[sys.argv.index('--')+1:])
    report={'schema':'three-d-export/material-consumer/v1','passed':False,'checks':[],'blender':bpy.app.version_string}
    try:
        assert bpy.app.version[:3] == (5,0,1), 'pinned actual Blender5.0.1 consumer required'
        bpy.ops.wm.read_factory_settings(use_empty=True)
        assert bpy.ops.import_scene.gltf(filepath=str(Path(a.glb).resolve())) == {'FINISHED'}
        parent=bpy.data.objects['parent']; first=bpy.data.objects['instance-a']; second=bpy.data.objects['instance-b']
        assert first.parent==parent and second.parent==parent
        close(bounds(first)[0],[2,-1,3]);close(bounds(first)[1],[3,-1,4])
        close(bounds(second)[0],[0,-1,2]);close(bounds(second)[1],[1,-1,3])
        assert len(first.data.polygons)==2 and len(second.data.polygons)==2
        assert first.data.uv_layers.active is not None
        for obj in [first,second]:
            assert {m.name for m in obj.data.materials}=={'checker-a','checker-b'}
            assert {poly.material_index for poly in obj.data.polygons}=={0,1}
            uv=[tuple(v.uv) for v in obj.data.uv_layers.active.data]
            # Blender importer maps glTF UV v to 1-v; native glTF checks original UVs exactly.
            assert set(uv)=={(0.,1.),(1.,1.),(0.,0.)}, uv
        images=[]
        for name,metal,rough in [('checker-a',0.25,0.75),('checker-b',0.5,0.25)]:
            m=bpy.data.materials[name]
            principled=next(n for n in m.node_tree.nodes if n.type=='BSDF_PRINCIPLED')
            close([principled.inputs['Metallic'].default_value,principled.inputs['Roughness'].default_value],[metal,rough])
            texture_nodes=[n for n in m.node_tree.nodes if n.type=='TEX_IMAGE' and n.image]
            assert texture_nodes
            assert any(link.from_node in texture_nodes for link in m.node_tree.links), 'actual texture link required'
            images.extend(n.image for n in texture_nodes)
        reference=bpy.data.images.load(str(Path(a.checker).resolve()),check_existing=False)
        assert any(tuple(i.size)==tuple(reference.size) and len(i.pixels)==len(reference.pixels) and all(abs(x-y)<1e-5 for x,y in zip(i.pixels,reference.pixels)) for i in images)
        report['checks'].append('portable_material_image_geometry_hierarchy')
        unchanged=second.matrix_world.copy()
        first.location.x+=1
        bpy.context.view_layer.update()
        for row,expected in zip(second.matrix_world,unchanged):close(row,expected)
        report['checks'].append('independent_instance_transform_edit')
        parent.location.x+=1
        bpy.context.view_layer.update()
        close(bounds(second)[0],[1,-1,2]);close(bounds(second)[1],[2,-1,3])
        report['checks'].append('parent_transform_edit')
        report['passed']=True
    except Exception as error:
        report['error']=f'{type(error).__name__}: {error}'
        report['traceback']=traceback.format_exc()
    Path(a.report).write_text(json.dumps(report,indent=2)+'\n')
    print(json.dumps(report))
    return 0 if report['passed'] else 1

sys.exit(main())
