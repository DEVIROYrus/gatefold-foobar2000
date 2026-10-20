"""
Builds the «AI music analysis» assets Gatefold downloads on demand (runs in CI: .github/workflows/ml-assets.yml).

  1. Downloads the Discogs-EffNet embedding model (ONNX) and the classification heads trained on its
     embeddings from essentia.upf.edu (Music Technology Group, UPF — CC BY-NC-SA 4.0).
  2. Converts the heads (TensorFlow frozen graphs) to ONNX with tf2onnx.
  3. Finds the exact framing Essentia uses in front of EffNet (frame start, patch hop) by comparing our
     own mel patches → ONNX against Essentia's TensorflowPredictEffnetDiscogs on test signals, and
     writes the winner into manifest.json — the browser side follows it.
  4. Writes reference data (test signals and expected outputs) so the JavaScript front end and
     onnxruntime-web can be checked against Essentia bit for bit (tests/ml_check.py).
  5. Adds onnxruntime-web's WebAssembly binary, so one download holds everything.

  python tools/ml/build_assets.py out/
"""
import hashlib, json, os, subprocess, sys, tarfile, io, urllib.request
from pathlib import Path
import numpy as np

OUT = Path(sys.argv[1] if len(sys.argv) > 1 else 'out')
BASE = 'https://essentia.upf.edu/models'
EFFNET_ONNX = f'{BASE}/feature-extractors/discogs-effnet/discogs-effnet-bsdynamic-1.onnx'
EFFNET_PB = f'{BASE}/feature-extractors/discogs-effnet/discogs-effnet-bs64-1.pb'
EFFNET_JSON = f'{BASE}/feature-extractors/discogs-effnet/discogs-effnet-bs64-1.json'
HEADS = ['genre_discogs400', 'mood_aggressive', 'mood_happy', 'mood_party', 'mood_relaxed', 'mood_sad', 'danceability',
         'voice_instrumental', 'mood_acoustic', 'mood_electronic', 'approachability_regression', 'engagement_regression',
         'tonal_atonal', 'timbre']
HEAD_DIR = {'approachability_regression': 'approachability', 'engagement_regression': 'engagement'}
ORT_VERSION = '1.22.0'
SR, FRAME, HOP, BANDS, PATCH = 16000, 512, 256, 96, 128

def get(url):
    req = urllib.request.Request(url, headers={'User-Agent': 'gatefold-ml-assets'})
    with urllib.request.urlopen(req, timeout=120) as r:
        return r.read()

def sha(b): return hashlib.sha256(b).hexdigest()

def main():
    (OUT / 'models').mkdir(parents=True, exist_ok=True)
    (OUT / 'reference').mkdir(parents=True, exist_ok=True)
    work = Path('work'); work.mkdir(exist_ok=True)
    manifest = {'version': 1, 'sampleRate': SR, 'frame': FRAME, 'hop': HOP, 'bands': BANDS, 'patch': PATCH, 'files': {}, 'heads': []}

    # ---------------------------------------------------------------- EffNet
    onnx_bytes = get(EFFNET_ONNX)
    (OUT / 'models' / 'discogs-effnet.onnx').write_bytes(onnx_bytes)
    (work / 'effnet.pb').write_bytes(get(EFFNET_PB))
    meta = json.loads(get(EFFNET_JSON))
    import onnx
    m = onnx.load_from_string(onnx_bytes)
    ins = [(i.name, [d.dim_value or d.dim_param for d in i.type.tensor_type.shape.dim]) for i in m.graph.input]
    outs = [(o.name, [d.dim_value or d.dim_param for d in o.type.tensor_type.shape.dim]) for o in m.graph.output]
    print('effnet inputs', ins, 'outputs', outs)
    manifest['effnet'] = {'file': 'discogs-effnet.onnx', 'input': ins[0][0], 'inputShape': ins[0][1], 'outputs': [o[0] for o in outs], 'outputShapes': [o[1] for o in outs],
                          'classes': meta.get('classes', [])}
    # which output is the 1280-d embedding, which the 400 activations
    emb_out = next((o[0] for o in outs if 1280 in o[1]), outs[-1][0]); act_out = next((o[0] for o in outs if 400 in o[1]), outs[0][0])
    manifest['effnet']['embeddingOutput'] = emb_out
    manifest['effnet']['activationOutput'] = act_out

    # ---------------------------------------------------------------- heads → ONNX
    for h in HEADS:
        d = HEAD_DIR.get(h, h)
        try:
            pb = get(f'{BASE}/classification-heads/{d}/{h}-discogs-effnet-1.pb')
            hj = json.loads(get(f'{BASE}/classification-heads/{d}/{h}-discogs-effnet-1.json'))
        except Exception as e:
            print('skip head', h, e); continue
        (work / f'{h}.pb').write_bytes(pb)
        schema = hj.get('schema', {})
        inp = schema.get('inputs', [{}])[0].get('name', 'model/Placeholder')
        outn = next((o['name'] for o in schema.get('outputs', []) if o.get('output_purpose') == 'predictions'), schema.get('outputs', [{}])[0].get('name'))
        dst = OUT / 'models' / f'{h}.onnx'
        r = subprocess.run([os.environ.get('TF_PYTHON', sys.executable), '-m', 'tf2onnx.convert', '--graphdef', str(work / f'{h}.pb'), '--output', str(dst),
                            '--inputs', f'{inp}:0', '--outputs', f'{outn}:0', '--opset', '17'], capture_output=True, text=True)
        if r.returncode or not dst.exists():
            print('convert failed', h, r.stderr[-800:]); continue
        hm = onnx.load(str(dst))
        manifest['heads'].append({'id': h, 'file': f'{h}.onnx', 'input': hm.graph.input[0].name, 'output': hm.graph.output[0].name,
                                  'classes': hj.get('classes', []), 'type': hj.get('type', '')})
        print('head', h, 'classes', len(hj.get('classes', [])))

    # ---------------------------------------------------------------- framing: match Essentia exactly
    import essentia.standard as es
    import onnxruntime as ort
    sess = ort.InferenceSession(str(OUT / 'models' / 'discogs-effnet.onnx'))
    signals = test_signals()
    win = es.Windowing(type='hann', normalized=False, zeroPhase=False, size=FRAME)(np.ones(FRAME, dtype=np.float32))
    mel = es.MelBands(numberBands=BANDS, sampleRate=SR, highFrequencyBound=8000, lowFrequencyBound=0, inputSize=FRAME // 2 + 1,
                      weighting='linear', normalize='unit_tri', warpingFormula='slaneyMel', type='power')
    def melframes(x, centered):
        if centered: x = np.concatenate([np.zeros(FRAME // 2, np.float32), x])
        n = 1 + (len(x) - FRAME) // HOP
        return np.stack([np.log10(1 + 10000 * mel(np.abs(np.fft.rfft(x[i * HOP:i * HOP + FRAME] * win)).astype(np.float32) ** 2)) for i in range(n)]).astype(np.float32)
    def patches(F, hop):
        n = 1 + (len(F) - PATCH) // hop
        return np.stack([F[i * hop:i * hop + PATCH] for i in range(n)])
    feed_shape = manifest['effnet']['inputShape']
    def run(P):
        x = P if len(feed_shape) == 3 else P[:, None, :, :]
        return sess.run([emb_out], {manifest['effnet']['input']: x})[0]
    effpb = es.TensorflowPredictEffnetDiscogs(graphFilename=str(work / 'effnet.pb'), output='PartitionedCall:1')
    best = None
    for centered in (False, True):
        for hop in (62, 64, 128):
            err = []
            for name, x in signals.items():
                ref = np.array(effpb(x))
                mine = run(patches(melframes(x, centered), hop))
                k = min(len(ref), len(mine))
                err.append(float(np.abs(ref[:k] - mine[:k]).max()) if k else 9e9)
            e = max(err)
            print('framing centered=%s hop=%d → max |Δ| %.5f' % (centered, hop, e))
            if best is None or e < best[0]: best = (e, centered, hop)
    manifest['framing'] = {'centered': best[1], 'patchHop': best[2], 'maxError': best[0]}
    print('framing', manifest['framing'])

    # ---------------------------------------------------------------- reference data for the JS side
    ref = {}
    for name, x in signals.items():
        (OUT / 'reference' / f'{name}.f32').write_bytes(x.astype('<f4').tobytes())
        F = melframes(x, best[1])
        P = patches(F, best[2])[:4]
        E = run(P)
        r = {'frames': int(len(F)), 'mel0': F[0].tolist(), 'mel10': F[10].tolist(), 'embeddingMean': E.mean(0).tolist(), 'heads': {}}
        for h in manifest['heads']:
            hs = ort.InferenceSession(str(OUT / 'models' / h['file']))
            r['heads'][h['id']] = hs.run([h['output']], {h['input']: E.astype(np.float32)})[0].mean(0).tolist()
        ref[name] = r
    (OUT / 'reference' / 'reference.json').write_text(json.dumps(ref))

    # ---------------------------------------------------------------- onnxruntime-web WebAssembly
    tgz = get(f'https://registry.npmjs.org/onnxruntime-web/-/onnxruntime-web-{ORT_VERSION}.tgz')
    with tarfile.open(fileobj=io.BytesIO(tgz)) as t:
        wasm = t.extractfile('package/dist/ort-wasm-simd-threaded.wasm').read()
    (OUT / 'models' / 'ort-wasm-simd-threaded.wasm').write_bytes(wasm)
    manifest['ort'] = {'version': ORT_VERSION, 'file': 'ort-wasm-simd-threaded.wasm'}

    for f in sorted((OUT / 'models').iterdir()):
        manifest['files'][f.name] = {'sha256': sha(f.read_bytes()), 'size': f.stat().st_size}
    (OUT / 'models' / 'manifest.json').write_text(json.dumps(manifest, indent=1))
    (OUT / 'models' / 'LICENSE-MODELS.md').write_text(LICENSE)
    print(json.dumps({k: v['size'] for k, v in manifest['files'].items()}, indent=1))

def test_signals():
    """deterministic test audio, 16 kHz mono: chords, a drum-and-noise pattern, a sweep"""
    rng = np.random.default_rng(7)
    t = np.arange(SR * 8) / SR
    nf = lambda m: 440 * 2 ** ((m - 69) / 12)
    chords = np.zeros_like(t)
    for i, ch in enumerate([[57, 60, 64], [53, 57, 60], [48, 52, 55], [55, 59, 62]]):
        seg = (t >= i * 2) & (t < i * 2 + 2)
        for n in ch:
            for hm in (1, 2, 3): chords[seg] += np.sin(2 * np.pi * nf(n) * hm * t[seg]) / hm
    chords *= 0.08
    beat = ((t * 3) % 1) < 0.04
    drums = np.tanh(6 * np.sin(2 * np.pi * 110 * t)) * 0.25 * (((t * 8) % 1) < 0.6) + beat * rng.standard_normal(len(t)) * 0.6
    sweep = 0.3 * np.sin(2 * np.pi * (100 * t + 400 * t * t))
    return {k: v.astype(np.float32) for k, v in {'chords': chords, 'drums': drums, 'sweep': sweep}.items()}

LICENSE = """# Models in this download

* **Discogs-EffNet** and the classification heads (genre_discogs400, mood_*, danceability, voice_instrumental,
  approachability, engagement, …) — Music Technology Group, Universitat Pompeu Fabra, https://essentia.upf.edu/models.html
  License: **CC BY-NC-SA 4.0** (https://creativecommons.org/licenses/by-nc-sa/4.0/). Non-commercial use only. The heads were
  converted from TensorFlow to ONNX for use in a web browser; the weights are unchanged.
  Alonso-Jiménez, P., Serra, X., & Bogdanov, D. (2023). Efficient supervised training of audio transformers for music
  representation learning. ISMIR.
* **onnxruntime-web** WebAssembly — Microsoft, MIT License.
"""

if __name__ == '__main__':
    main()
