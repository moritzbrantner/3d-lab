"""Encode fixed SOURCE fixtures only; never serialize production export output."""
import json
import struct
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2] / 'crates/three-d-export/tests/fixtures'

def fixture(textured):
    binary = bytearray()
    views, accessors = [], []
    def accessor(values, width, kind, target):
        offset = len(binary)
        flat = [x for row in values for x in row]
        binary.extend(struct.pack('<' + kind * len(flat), *flat))
        views.append({'buffer': 0, 'byteOffset': offset, 'byteLength': len(binary)-offset, 'target': target})
        value = {'bufferView': len(views)-1, 'componentType': 5126 if kind == 'f' else 5125,
                 'count': len(values), 'type': {1:'SCALAR',2:'VEC2',3:'VEC3'}[width]}
        if width == 3 and kind == 'f' and values == [[0,0,0],[1,0,0],[0,1,0]]:
            value.update(min=[0,0,0], max=[1,1,0])
        accessors.append(value)
        return len(accessors)-1
    positions = accessor([[0,0,0],[1,0,0],[0,1,0]],3,'f',34962)
    normals = accessor([[0,0,1]]*3,3,'f',34962)
    uvs = accessor([[0,0],[1,0],[0,1]],2,'f',34962)
    indices = accessor([[0],[1],[2]],1,'I',34963)
    primitives = [{'attributes':{'POSITION':positions,'NORMAL':normals,'TEXCOORD_0':uvs},'indices':indices,'mode':4} for _ in range(2)]
    doc = {'asset':{'version':'2.0'},'buffers':[{'byteLength':0}], 'bufferViews':views,'accessors':accessors,
           'meshes':[{'name':'two-primitives','primitives':primitives}],
           'nodes':[{'name':'parent','translation':[3,2,1],'rotation':[0,0,2**-0.5,2**-0.5],'children':[1,2]},
                    {'name':'instance-a','mesh':0,'translation':[1,0,0]},
                    {'name':'instance-b','mesh':0,'translation':[0,2,0]}],
           'scenes':[{'nodes':[0]}],'scene':0}
    if textured:
        image = (ROOT/'checker.png').read_bytes()
        offset=len(binary); binary.extend(image)
        views.append({'buffer':0,'byteOffset':offset,'byteLength':len(image)})
        doc.update(images=[{'name':'checker','bufferView':len(views)-1,'mimeType':'image/png'}],
                   samplers=[{'magFilter':9728,'minFilter':9728,'wrapS':33071,'wrapT':33648}],
                   textures=[{'source':0,'sampler':0}],
                   materials=[{'name':name,'doubleSided':True,'pbrMetallicRoughness':{'baseColorFactor':color,
                       'metallicFactor':metal,'roughnessFactor':rough,'baseColorTexture':{'index':0}}}
                       for name,color,metal,rough in [('checker-a',[1,0.5,0.25,1],0.25,0.75),('checker-b',[0.25,1,0.5,1],0.5,0.25)]])
        for i,p in enumerate(primitives):p['material']=i
    doc['buffers'][0]['byteLength']=len(binary)
    raw=json.dumps(doc,separators=(',',':')).encode()
    raw+=b' '*((-len(raw))%4);binary.extend(b'\0'*((-len(binary))%4))
    out=struct.pack('<III',0x46546c67,2,12+8+len(raw)+8+len(binary))+struct.pack('<II',len(raw),0x4e4f534a)+raw+struct.pack('<II',len(binary),0x004e4942)+binary
    (ROOT/('textured.glb' if textured else 'geometry-only.glb')).write_bytes(out)

fixture(True)
fixture(False)
