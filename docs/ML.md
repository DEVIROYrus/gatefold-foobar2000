# Sound analysis (AI) — how it is built

| Piece | Where |
|---|---|
| Mel front end, bit-for-bit Essentia's `TensorflowInputMusiCNN` (16 kHz, 512/256 Hann, 96 Slaney bands, `log10(1+10000x)`) | `theme/js/ml/frontend.js`, tables from `tools/ml/make_melbank.py` → `theme/js/ml/melbank.js` |
| Network in a Web Worker (onnxruntime-web 1.22, WebAssembly, 1 thread) | `theme/js/ml/worker.js`, `theme/js/vendor/ort/` |
| Model download (SHA-256 checked, kept in IndexedDB) | `theme/js/ml/models.js` |
| Indexer (two 24-s pieces per track, non-overlapping patches; decode pipeline; speed levels; worker pool), similarity, moods, styles (album- and library-weighted) | `theme/js/ml/sound.js` |
| Resampling to 16 kHz when decoding at the file's own rate (polyphase windowed sinc; embedding cosine 0.9999 vs Essentia's best resampler) | `theme/js/ml/frontend.js` |
| Settings section, Now playing chips, «Similar tracks», mood/style playlists | `theme/js/ml/sound-ui.js` |
| Radio v3 | `theme/js/radio.js` |

## The models

[Discogs-EffNet](https://essentia.upf.edu/models.html#discogs-effnet) (EfficientNet-B0 trained on Discogs metadata, 400 styles) gives a 1280-number
embedding per ~2-second mel patch; classification heads trained on those embeddings give moods (aggressive, happy, party,
relaxed, sad), danceability, voice/instrumental, acoustic, electronic. All by the Music Technology Group, Universitat Pompeu Fabra,
under **CC BY-NC-SA 4.0** — non-commercial use only. They are not in this repository, the theme archive or the installer.

## Publishing them

The **ML assets** workflow (`.github/workflows/ml-assets.yml`, runs on changes to `tools/ml/**` or by hand) runs
`tools/ml/build_assets.py`, which:

1. downloads the EffNet ONNX model and the heads from essentia.upf.edu;
2. converts the heads (TensorFlow graphs) to ONNX with tf2onnx;
3. finds the framing Essentia uses (frame start, patch hop) by comparing our front end + the ONNX model with Essentia's
   `TensorflowPredictEffnetDiscogs` on test signals, and fails the run if they differ by more than 0.02;
4. writes reference outputs, adds onnxruntime-web's `.wasm`, and a `manifest.json` with every file's SHA-256;
5. publishes everything on the orphan branch **`ml-assets`** (the theme downloads from raw.githubusercontent.com) and as the
   pre-release **`ml-models-1`** (a mirror; never marked «latest», so the theme updater ignores it).

Run it once after forking (Actions → ML assets → Run workflow). Until it has run, the setting says the models are not published yet.

## Tests

`tools/ml/fake_assets.py` makes tiny stand-in networks with the same manifest; `tests/e2e.py → test_sound_ai` downloads them through a
mocked raw.githubusercontent.com, indexes the mock library, and checks «Similar tracks», the radio, mood and style playlists and removal.
`localStorage['gatefold.ml.pace'] = '0'` removes the pacing in tests.
