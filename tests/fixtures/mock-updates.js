// mock-updates.js — a GitHub release for the updater, the template folder it writes into, and the
// volume calls. window.__updCfg (set before load) tunes it; what happened is kept in sessionStorage
// so it survives the reload that ends an update.
(() => {
  const base = window.fb2k.invoke.bind(window.fb2k);
  const ok = (x) => Promise.resolve({ success: true, ...x });
  const S = (k, v) => { const a = JSON.parse(sessionStorage.getItem('upd.' + k) || '[]'); if (v !== undefined) { a.push(v); sessionStorage.setItem('upd.' + k, JSON.stringify(a)); } return a; };
  const cfg = () => Object.assign({ version: '1.1.0', comp: '2.0.0', badSum: false }, JSON.parse(sessionStorage.getItem('upd.cfg') || '{}'));
  const DIR = 'C:\\Users\\me\\AppData\\Roaming\\foobar2000-v2\\webview-ui\\gatefold';
  const REL = 'https://github.com/test/gatefold/releases';
  const b64 = (u) => { let s = ''; for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode.apply(null, u.subarray(i, i + 0x8000)); return btoa(s); };
  window.__upd = { DIR, S, set: (o) => sessionStorage.setItem('upd.cfg', JSON.stringify({ ...cfg(), ...o })) };

  window.fb2k.invoke = async (m, p = {}) => {
    const c = cfg();
    if (m === 'http.get' && /api\.github\.com\/repos\/test\/gatefold\/releases\/latest/.test(p.url)) {
      S('checks', p.url);
      const v = c.version;
      return ok({ status: 200, body: JSON.stringify({ tag_name: 'v' + v, name: 'Gatefold ' + v, published_at: '2026-10-10T10:00:00Z', html_url: `${REL}/tag/v${v}`,
        body: `## What's new\n- **Faster** library scrolling\n- Fixed \`tooltips\` — see [notes](https://example.com/notes)\n\nSHA-256:\n\`\`\`\n${'a'.repeat(64)}  x.zip\n\`\`\``,
        assets: [{ name: `gatefold-theme-${v}.zip`, browser_download_url: `${REL}/download/v${v}/gatefold-theme-${v}.zip`, size: 1 },
                 { name: 'SHA256SUMS.txt', browser_download_url: `${REL}/download/v${v}/SHA256SUMS.txt` },
                 { name: `Gatefold-Setup-${v}.exe`, browser_download_url: `${REL}/download/v${v}/Gatefold-Setup-${v}.exe` }] }) });
    }
    if (m === 'http.get' && /releases\/download\/.+\.zip$/.test(p.url)) {
      S('downloads', p.url);
      return ok({ status: 200, body: b64(new Uint8Array(await (await fetch('/__upd/theme.zip')).arrayBuffer())) });
    }
    if (m === 'http.get' && /releases\/download\/.+SHA256SUMS\.txt$/.test(p.url)) {
      const t = await (await fetch('/__upd/sums.txt')).text();
      return ok({ status: 200, body: c.badSum ? t.replace(/^[0-9a-f]{64}/, '0'.repeat(64)) : t });
    }
    if (m === 'webview.getSource') return ok({ source: 'file:///' + DIR.replace(/\\/g, '/') + '/index.html', directory: DIR, templateName: 'gatefold', activeTemplateName: 'gatefold', templatesDirectory: DIR.replace(/\\gatefold$/, '') });
    if (m === 'config.getComponents') return ok({ components: [{ name: 'WebView2 UI', version: c.comp, filename: 'foo_ui_webview2' }, { name: 'Standard Input Array', version: '1.0', filename: 'foo_input_std' }] });
    if (m === 'file.mkdir') { S('mkdir', p.path); return ok({ path: p.path, created: true }); }
    if (m === 'file.copy') { S('copies', [p.source, p.destination, !!p.overwrite]); return ok({ source: p.source, destination: p.destination }); }
    if (m === 'file.exists') return ok({ exists: true, path: p.path });
    if (m === 'file.write' && p.path.startsWith(DIR + '\\')) {
      const rel = p.path.slice(DIR.length + 1);
      S('written', [rel, !!p.atomic, p.encoding]);
      if (rel === 'js\\version.js') sessionStorage.setItem('upd.versionjs', decodeURIComponent(escape(atob(p.content.replace(/^base64:/, '')))));
      return ok({ bytesWritten: p.content.length });
    }
    if (m === 'playback.setVolume' || m === 'playback.toggleMute') { window.__calls.push([m, JSON.stringify(p)]); if (m === 'playback.setVolume') setTimeout(() => window.__emit('playback:volumeChanged', { volume: p.volume, isMuted: false }), 10); return ok({}); }
    return base(m, p);
  };
})();
