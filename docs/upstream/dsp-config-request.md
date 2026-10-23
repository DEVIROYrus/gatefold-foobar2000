# Request to foo_ui_webview2: DSP settings — read, write, and open a DSP's own dialog

*Draft issue for https://github.com/NereaFantasia/foo_ui_webview2 — feel free to post it.*

**Problem.** A theme can list the DSP chain (`dsp.getChain`), switch presets (`dsp.applyPreset`, `config.setActiveDspPreset`) and add a processor with its default settings (`dsp.addDsp`). It cannot read or change the settings of a processor that is already in the chain. For the most-asked case — an equalizer drawn in the theme, with bands that move while the music plays — that is the missing piece: today a theme can only send the user to the native Equalizer window or the DSP Manager.

A user of Gatefold asked for exactly this: an equalizer inside the interface. Gatefold now switches DSP presets from its player bar and opens foobar2000's own Equalizer and DSP Manager; the bands themselves need the component.

**Proposal** (in order of value; each is useful alone):

1. **Open a processor's own settings dialog.**
   `dsp.showConfig({ index } | { guid })` — for an entry of the active chain, show the processor's dialog
   (`dsp_entry::g_show_config_popup_v2` with a `dsp_preset_edit_callback` that writes the edited preset back
   through `dsp_config_manager::core_enable_dsp`, or `dsp_config_manager::configure_popup` for the whole chain).
   Returns `{ changed: boolean }`. This alone gives every DSP — equalizer, compressor, resampler — a
   «Settings…» button in a theme.

2. **Raw settings, read and write.**
   `dsp.getConfig({ index } | { guid })` → `{ guid, name, data: string /* base64 of dsp_preset::get_data */ }`
   (`dsp_config_manager::core_query_dsp`), and
   `dsp.setConfig({ guid, data })` → replaces that processor's settings in the active chain
   (`core_enable_dsp` with a `dsp_preset_impl` built from the bytes), firing `audio:dspPresetChanged`.
   The format of each processor's data is its own business; a theme that knows a format (or only stores
   and restores bytes, e.g. per-album EQ curves) can use it.

3. **A typed equalizer** (the stock Equalizer, `foo_dsp_std`): `equalizer.get()` →
   `{ enabled, preamp, bands: [{ hz, gain }] }` and `equalizer.set({ bands?, preamp?, enabled? })`, built on (2)
   inside the component, where the stock format can be kept in step with foobar2000 versions. This is what
   lets a theme draw sliders without depending on an undocumented byte layout.

**Notes.**
- All three run on the main thread and go through `dsp_config_manager`, so the native DSP Manager and the
  Equalizer window stay in sync; `audio:dspPresetChanged` already exists for the theme to refresh.
- Errors in the usual shape: `NOT_FOUND` (no such processor in the chain), `INVALID_PARAMS` (bad base64),
  `UNSUPPORTED` (the processor has no dialog — `dsp_entry::have_config_popup()` is false).

---

# 向 foo_ui_webview2 的请求：DSP 设置的读取、写入和打开 DSP 自己的设置窗口

主题目前可以列出 DSP 链、切换预设、按默认设置添加 DSP，但无法读取或修改链中已有 DSP 的设置，因此无法在主题里绘制均衡器。

建议（按价值排序，任一项单独都有用）：
1. `dsp.showConfig({ index } | { guid })` — 打开链中该 DSP 自己的设置窗口（`dsp_entry::g_show_config_popup_v2`，修改后经 `dsp_config_manager::core_enable_dsp` 写回），返回 `{ changed }`。
2. `dsp.getConfig` / `dsp.setConfig` — 以 base64 读写 `dsp_preset` 的原始数据（`core_query_dsp` / `core_enable_dsp`），写入后触发 `audio:dspPresetChanged`。
3. 内置均衡器的类型化接口：`equalizer.get()` → `{ enabled, preamp, bands: [{ hz, gain }] }`，`equalizer.set(...)`，由组件负责处理内置格式。
