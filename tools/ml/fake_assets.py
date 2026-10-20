"""
Stand-in ML assets for tests: same layout and manifest as tools/ml/build_assets.py, but tiny made-up
networks instead of Discogs-EffNet (the real models are not in this repository and are downloaded
by users only). The stand-in «EffNet» averages each mel patch over time and projects it at random,
which keeps spectrally different audio apart — enough to test the pipeline, the indexer and the radio.

  python tools/ml/fake_assets.py out/   (needs onnx, numpy; copies the onnxruntime-web wasm from node_modules)
"""
import hashlib, json, shutil, sys
from pathlib import Path
import numpy as np
import onnx
from onnx import helper, TensorProto, numpy_helper

OUT = Path(sys.argv[1] if len(sys.argv) > 1 else 'out') / 'models'
OUT.mkdir(parents=True, exist_ok=True)
rng = np.random.default_rng(42)

def save(model, name):
    model.opset_import[0].version = 18
    model.ir_version = 9
    onnx.checker.check_model(model)
    onnx.save(model, str(OUT / name))

# «EffNet»: [N,128,96] → mean over time → [N,96] → (x-2)·W1 → tanh → emb[N,1280]; emb·W2 → sigmoid → act[N,400]
W1 = (rng.standard_normal((96, 1280)) / np.sqrt(96)).astype(np.float32)
W2 = (rng.standard_normal((1280, 400)) / np.sqrt(1280)).astype(np.float32)
g = helper.make_graph(
    [helper.make_node('ReduceMean', ['melspectrogram', 'axes'], ['m'], keepdims=0),
     helper.make_node('Sub', ['m', 'two'], ['mc']),
     helper.make_node('MatMul', ['mc', 'W1'], ['e0']),
     helper.make_node('Tanh', ['e0'], ['embeddings']),
     helper.make_node('MatMul', ['embeddings', 'W2'], ['a0']),
     helper.make_node('Sigmoid', ['a0'], ['activations'])],
    'fake_effnet',
    [helper.make_tensor_value_info('melspectrogram', TensorProto.FLOAT, ['batch', 128, 96])],
    [helper.make_tensor_value_info('activations', TensorProto.FLOAT, ['batch', 400]),
     helper.make_tensor_value_info('embeddings', TensorProto.FLOAT, ['batch', 1280])],
    [numpy_helper.from_array(np.array([1], np.int64), 'axes'), numpy_helper.from_array(np.array(2, np.float32), 'two'),
     numpy_helper.from_array(W1, 'W1'), numpy_helper.from_array(W2, 'W2')])
save(helper.make_model(g), 'discogs-effnet.onnx')

STYLES = [f'Genre---Style {i}' for i in range(400)]
for i, s in enumerate(['Rock---Doom Metal', 'Rock---Gothic Metal', 'Rock---Thrash', 'Electronic---Ambient', 'Jazz---Cool Jazz', 'Pop---Ballad']):
    STYLES[i] = s
HEADS = [('mood_aggressive', ['aggressive', 'not_aggressive']), ('mood_relaxed', ['non_relaxed', 'relaxed']), ('mood_sad', ['non_sad', 'sad']),
         ('mood_happy', ['happy', 'non_happy']), ('mood_party', ['non_party', 'party']), ('danceability', ['danceable', 'not_danceable']),
         ('voice_instrumental', ['instrumental', 'voice']), ('mood_acoustic', ['acoustic', 'non_acoustic']), ('mood_electronic', ['electronic', 'non_electronic'])]
# the heads «hear» brightness: the embedding direction that separates a bright, harsh spectrum from a dark, bassy one
dark = np.tanh((np.r_[np.full(20, 3.0), np.zeros(76)] - 2) @ W1); bright = np.tanh((np.r_[np.full(20, 1.0), np.full(76, 2.5)] - 2) @ W1)
u = bright - dark; u /= np.linalg.norm(u); mid = (bright + dark) / 2 @ u; k = 6 / max(1e-6, (bright - dark) @ u)
SIGN = {'mood_aggressive': 1, 'mood_relaxed': -1, 'mood_sad': -1, 'mood_happy': 1, 'mood_party': 1, 'danceability': 1, 'voice_instrumental': -1, 'mood_acoustic': -1, 'mood_electronic': 1}
heads = []
for hid, classes in HEADS:
    pos = 0 if classes[0] in ('aggressive', 'happy', 'danceable', 'instrumental', 'acoustic', 'electronic') else 1
    W = np.zeros((1280, 2), np.float32); W[:, pos] = SIGN[hid] * k * u
    B = np.zeros(2, np.float32); B[pos] = -SIGN[hid] * k * mid
    g = helper.make_graph([helper.make_node('MatMul', ['model/Placeholder', 'W'], ['z0']), helper.make_node('Add', ['z0', 'B'], ['z']),
                           helper.make_node('Softmax', ['z'], ['model/Softmax'], axis=-1)], hid,
                          [helper.make_tensor_value_info('model/Placeholder', TensorProto.FLOAT, ['batch', 1280])],
                          [helper.make_tensor_value_info('model/Softmax', TensorProto.FLOAT, ['batch', 2])], [numpy_helper.from_array(W, 'W'), numpy_helper.from_array(B, 'B')])
    save(helper.make_model(g), f'{hid}.onnx')
    heads.append({'id': hid, 'file': f'{hid}.onnx', 'input': 'model/Placeholder', 'output': 'model/Softmax', 'classes': classes, 'type': 'multi-class classifier'})

wasm = Path(__file__).resolve().parents[2] / 'node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.wasm'
shutil.copy(wasm, OUT / 'ort-wasm-simd-threaded.wasm')
manifest = {'version': 1, 'fake': True, 'sampleRate': 16000, 'frame': 512, 'hop': 256, 'bands': 96, 'patch': 128,
            'effnet': {'file': 'discogs-effnet.onnx', 'input': 'melspectrogram', 'inputShape': ['batch', 128, 96], 'outputs': ['activations', 'embeddings'],
                       'embeddingOutput': 'embeddings', 'activationOutput': 'activations', 'classes': STYLES},
            'heads': heads, 'framing': {'centered': False, 'patchHop': 62, 'maxError': 0}, 'ort': {'version': '1.22.0', 'file': 'ort-wasm-simd-threaded.wasm'}, 'files': {}}
for f in sorted(OUT.iterdir()):
    if f.suffix in ('.onnx', '.wasm'):
        manifest['files'][f.name] = {'sha256': hashlib.sha256(f.read_bytes()).hexdigest(), 'size': f.stat().st_size}
(OUT / 'manifest.json').write_text(json.dumps(manifest, indent=1))
print('fake assets in', OUT, {k: v['size'] for k, v in manifest['files'].items()})
