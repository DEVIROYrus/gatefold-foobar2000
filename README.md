# Gatefold · headphone equalizer database

Data read by Gatefold's «Equalizer → Headphones» (served through jsDelivr from this branch).

- `v1/index.json` — every model: `[id, name, form, [source indices]]`, the sources, the 48 frequencies of the curves
- `v1/m/<id>.json` — one model: per measurement its response (`fr`), target (`tg`) and parametric settings (`neutral`, `bass`, `warm`: preamp + `[type, Hz, Q, dB]`)

Built from [AutoEq](https://github.com/jaakkopasanen/AutoEq) (MIT, © Jaakko Pasanen) — measurements by oratory1990, Rtings, Innerfidelity, HypetheSonics and others; settings computed with AutoEq's own optimizer for 48 kHz.
