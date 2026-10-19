// mock-prefs.js — foobar2000's own configuration for Settings → foobar2000 (config.*, replaygain.*,
// library.getRoots). State lives in window.__prefs; every write is recorded in window.__calls.
(() => {
  const base = window.fb2k.invoke.bind(window.fb2k);
  const ok = (x) => Promise.resolve({ success: true, ...x });
  const Z = '{00000000-0000-0000-0000-000000000000}';
  const DS = '{D41D2423-FBB0-4635-B233-7054F79814AB}', WS = '{5243F9AD-C84F-4723-8194-0788FC021BCC}', WX = '{F0FA1C39-1E3B-4D14-8B6C-6F0E3B5A1C77}';
  const P = window.__prefs = {
    devices: [
      { name: 'Primary Sound Driver', outputId: DS, deviceId: Z, isCurrent: false },
      { name: 'Speakers (Realtek(R) Audio)', outputId: DS, deviceId: '{11111111-1111-1111-1111-111111111111}', isCurrent: false },
      { name: 'Default : Speakers (Realtek(R) Audio) [WASAPI shared]', outputId: WS, deviceId: Z, isCurrent: true },
      { name: 'Speakers (Realtek(R) Audio) [Exclusive]', outputId: WX, deviceId: '{22222222-2222-2222-2222-222222222222}', isCurrent: false },
      { name: 'Headphones (USB DAC) [Exclusive]', outputId: WX, deviceId: '{33333333-3333-3333-3333-333333333333}', isCurrent: false },
    ],
    buffer: 1, rg: { sourceMode: 'album', processingMode: 'gain_and_peak', preampWithRg: 0, preampWithoutRg: -6 },
    presets: [{ index: 0, name: 'Default' }, { index: 1, name: 'Night (compressor)' }], active: 0,
    pfc: false, cfp: true,
    adv: [
      { name: 'Display', guid: '{A1}', type: 'branch', sortPriority: 0, children: [
        { name: 'Album art', guid: '{A2}', type: 'branch', sortPriority: 0, children: [
          { name: 'Stub image path', guid: '{A3}', type: 'string', value: '', defaultValue: '', sortPriority: 0, isSigned: false, isFilePath: true, isFolderPath: false } ] },
        { name: 'Show tooltips in playlist', guid: '{A4}', type: 'checkbox', value: true, defaultValue: true, sortPriority: 0 } ] },
      { name: 'Playback', guid: '{B1}', type: 'branch', sortPriority: 0, children: [
        { name: 'Full file buffering up to (kB)', guid: '{B2}', type: 'integer', value: '0', defaultValue: '0', sortPriority: 0, isSigned: false, isFilePath: false, isFolderPath: false },
        { name: 'Thread priority (1-7)', guid: '{B3}', type: 'integer', value: '2', defaultValue: '2', sortPriority: 0, isSigned: false, isFilePath: false, isFolderPath: false },
        { name: 'Seek', guid: '{B4}', type: 'branch', sortPriority: 0, children: [
          { name: 'Fast seek', guid: '{B5}', type: 'radio', value: true, defaultValue: true, sortPriority: 0 },
          { name: 'Accurate seek', guid: '{B6}', type: 'radio', value: false, defaultValue: false, sortPriority: 0 } ] } ] },
      { name: 'Tagging', guid: '{C1}', type: 'branch', sortPriority: 0, children: [
        { name: 'Create ID3v2 tags when writing MP3', guid: '{C2}', type: 'checkbox', value: false, defaultValue: true, sortPriority: 0 },
        { name: 'CUE sheet: write REM tags', guid: '{C3}', type: 'checkbox', value: true, defaultValue: true, sortPriority: 0 } ] },
    ],
  };
  const find = (g, list = P.adv) => { for (const e of list) { if (e.guid === g) return { e, list }; if (e.children) { const r = find(g, e.children); if (r) return r; } } return null; };
  const rec = (m, p) => window.__calls.push([m, JSON.stringify(p)]);
  window.fb2k.invoke = async (m, p = {}) => {
    switch (m) {
      case 'config.getOutputDevices': return ok({ devices: P.devices.map((d) => ({ ...d, id: d.deviceId })), count: P.devices.length });
      case 'config.getOutputConfig': { const c = P.devices.find((d) => d.isCurrent); return ok({ outputId: c.outputId, deviceId: c.deviceId, bufferLength: P.buffer, bitDepth: 24, useDither: true, useFades: false, outputName: 'WASAPI (shared)', deviceName: c.name }); }
      case 'config.setOutputDevice': rec(m, p); P.devices.forEach((d) => (d.isCurrent = d.outputId === p.outputId && d.deviceId === p.deviceId)); return ok({});
      case 'config.setOutputBuffer': rec(m, p); P.buffer = p.milliseconds / 1000; return ok({});
      case 'replaygain.getSettings': return ok({ ...P.rg, active: true });
      case 'replaygain.setMode': rec(m, p); Object.assign(P.rg, p); return ok({ sourceMode: P.rg.sourceMode, processingMode: P.rg.processingMode, changed: true });
      case 'replaygain.setPreamp': rec(m, p); if ('withRg' in p) P.rg.preampWithRg = p.withRg; if ('withoutRg' in p) P.rg.preampWithoutRg = p.withoutRg; return ok({ withRg: P.rg.preampWithRg, withoutRg: P.rg.preampWithoutRg });
      case 'config.getDspPresets': return ok({ presets: P.presets, count: P.presets.length });
      case 'config.getActiveDspPreset': return ok({ index: P.active, name: P.presets[P.active].name, isActive: true });
      case 'config.setActiveDspPreset': rec(m, p); P.active = p.index; return ok({});
      case 'config.getPlaybackFollowCursor': return ok({ enabled: P.pfc });
      case 'config.getCursorFollowPlayback': return ok({ enabled: P.cfp });
      case 'config.setPlaybackFollowCursor': rec(m, p); P.pfc = p.enabled; return ok({ enabled: P.pfc });
      case 'config.setCursorFollowPlayback': rec(m, p); P.cfp = p.enabled; return ok({ enabled: P.cfp });
      case 'config.getLibraryStatus': return ok({ enabled: true, itemCount: 12840, initialized: true });
      case 'library.getRoots': return ok({ enabled: true, total: 2, roots: [
        { id: 'D:\\Music', displayName: 'Music', rawPath: 'D:\\Music', absolutePath: 'D:\\Music', trackCount: 11902 },
        { id: 'E:\\Vinyl rips', displayName: 'Vinyl rips', rawPath: 'E:\\Vinyl rips', absolutePath: 'E:\\Vinyl rips', trackCount: 938 }] });
      case 'config.showLibraryPreferences': case 'misc.showPreferences': case 'misc.showConsole': rec(m, p); return ok({});
      case 'config.getAdvancedConfig': return ok({ entries: JSON.parse(JSON.stringify(P.adv)), count: P.adv.length });
      case 'config.getAdvancedConfigValue': { const f = find(p.guid); return f ? ok({ name: f.e.name, guid: p.guid, type: f.e.type, value: f.e.type === 'integer' ? +f.e.value : f.e.value }) : Promise.resolve({ success: false, code: 'NOT_FOUND' }); }
      case 'config.setAdvancedConfigValue': { rec(m, p); const f = find(p.guid); if (!f) return { success: false, code: 'NOT_FOUND' };
        if (f.e.type === 'radio') f.list.forEach((x) => { if (x.type === 'radio') x.value = x === f.e; }); else f.e.value = f.e.type === 'integer' ? String(parseInt(p.value, 10)) : p.value; return ok({}); }
      case 'config.resetAdvancedConfig': { rec(m, p); const f = find(p.guid); if (f) f.e.value = f.e.defaultValue; return ok({}); }
    }
    return base(m, p);
  };
})();
