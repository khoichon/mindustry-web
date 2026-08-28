// stub-natives.js
// SoLoud (audio) natives. FreeType used to be stubbed here too - it now has a real
// implementation in freetype-shim.js (canvas-backed glyph rendering), see that file
// for details. native-filedialogs stubs were removed entirely: this jar contains no
// FileDialogs class at all (verified via javap) - Mindustry's import/export UIs
// browse the Java filesystem in-game via arc.files.Fi, so browser upload/download
// is handled by the file bridge in index.html (Files.write/Files.readAllBytes
// against the running instance's lib handle), not by dialog natives.

(function (global) {
  'use strict';
  const NATIVES = {};

  // =====================================================================
  // SoLoud (arc.audio.Soloud) - package-private class, no dots to mangle
  // beyond "arc_audio_Soloud"
  // =====================================================================
  function nativeAudio(name, fn) { NATIVES['Java_arc_audio_Soloud_' + name] = fn; }

  const AudioCtx = window.AudioContext || window.webkitAudioContext;
  const actx = new AudioCtx();
  const masterGain = actx.createGain();
  masterGain.connect(actx.destination);

  const sources = new Map();   // handle(long) -> {buffer: AudioBuffer, kind:'wav'|'stream'}
  const voices = new Map();    // voiceId(int) -> {node: AudioBufferSourceNode, gain, pan, source}
  let nextHandle = 1;
  let nextVoice = 1;

  // Java `long` handle args can arrive as Number or BigInt (scalar-long marshalling
  // is LiveConnect-style Number, but be robust to both) - normalize to the Number
  // keys `sources` is stored under. See freetype-shim.js's h() for the full story.
  function H(hndl) { return typeof hndl === 'bigint' ? Number(hndl) : hndl; }
  function src(hndl) { return sources.get(H(hndl)); }

  async function decode(bytes) {
    // bytes is expected to already be a Uint8Array (see readBuffer-style helper below)
    const copy = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
    return actx.decodeAudioData(copy);
  }

  nativeAudio('init', async () => { if (actx.state === 'suspended') { const resume = () => { actx.resume(); document.removeEventListener('pointerdown', resume); }; document.addEventListener('pointerdown', resume); } });
  nativeAudio('deinit', async () => actx.close());
  nativeAudio('backendString', async () => 'WebAudio');
  nativeAudio('backendId', async () => 0);
  nativeAudio('backendChannels', async () => 2);
  nativeAudio('backendSamplerate', async () => actx.sampleRate);
  nativeAudio('backendBufferSize', async () => 1024);
  nativeAudio('version', async () => 1);
  nativeAudio('activeVoiceCount', async () => voices.size);
  nativeAudio('stopAll', async () => { for (const v of voices.values()) try { v.node.stop(); } catch (e) {} voices.clear(); });
  nativeAudio('pauseAll', async () => { actx.state === 'running' ? actx.suspend() : actx.resume(); });

  nativeAudio('wavLoadBytes', async (lib, bytes, length) => {
    const buf = await decode(bytes.subarray ? bytes.subarray(0, length) : bytes);
    const hndl = nextHandle++;
    sources.set(hndl, { buffer: buf });
    return hndl;
  });
  nativeAudio('streamLoadBytes', async (lib, bytes, length) => NATIVES['Java_arc_audio_Soloud_wavLoadBytes'](lib, bytes, length));
  // The v158.1 jar's Soloud declares these under DIFFERENT names than the Arc repo source
  // (wavLoad/streamLoad here vs wavLoadBytes/wavLoadFile in the repo) - cross-checked
  // against javap of the jar's Soloud.class. The jar is ground truth, so these are the
  // names that must resolve; the repo-named registrations above are kept too (harmless).
  nativeAudio('wavLoad', async (lib, bytes, length) => NATIVES['Java_arc_audio_Soloud_wavLoadBytes'](lib, bytes, length));
  nativeAudio('streamLoad', async (lib, path) => NATIVES['Java_arc_audio_Soloud_wavLoadFile'](lib, path));
  nativeAudio('wavLength', async (lib, h) => src(h)?.buffer.duration || 0);
  nativeAudio('streamLength', async (lib, h) => src(h)?.buffer.duration || 0);
  nativeAudio('sourceDestroy', async (lib, h) => sources.delete(H(h)));

  function playVoice(handle, volume, pitch, pan, loop) {
    const source = src(H(handle));
    if (!source) return -1;
    if (source.singleInstance) { // stop any already-playing instance of this same source first
      for (const [id, v] of voices) if (v.sourceHandle === H(handle)) { try { v.node.stop(); } catch (e) {} voices.delete(id); }
    }
    const node = actx.createBufferSource();
    node.buffer = source.buffer;
    node.loop = !!loop;
    node.playbackRate.value = pitch || 1;
    const gain = actx.createGain();
    gain.gain.value = volume ?? 1;
    const panner = actx.createStereoPanner();
    panner.pan.value = pan || 0;
    node.connect(gain).connect(panner).connect(masterGain);
    node.start();
    const id = nextVoice++;
    voices.set(id, { node, gain, panner, sourceHandle: H(handle) });
    node.onended = () => voices.delete(id);
    return id;
  }
  nativeAudio('sourcePlay', async (lib, h, volume, pitch, pan, loop) => playVoice(h, volume ?? 1, pitch ?? 1, pan ?? 0, loop ?? src(h)?.defaultLoop ?? false));
  nativeAudio('sourcePlayBus', async (lib, h, busHandle, volume, pitch, pan, loop) => playVoice(h, volume ?? 1, pitch ?? 1, pan ?? 0, loop ?? src(h)?.defaultLoop ?? false));
  // sourcePlay is OVERLOADED in the Java source - sourcePlay(long) and
  // sourcePlay(long,float,float,float,boolean) - and real JNI requires the long-form
  // mangled name (argument-type-suffixed) for every overload of an overloaded native,
  // not just the short form above. This project has been bitten by exactly this class
  // of mangling issue twice already (GL overload handling in gl-shim.js, and the
  // nested-class prefix bug in freetype-shim.js), so registering both long-form names
  // defensively here rather than waiting for a real playback attempt to surface it as
  // yet another UnsatisfiedLinkError. `__` separates method name from the mangled
  // argument descriptor; J/F/Z are the raw JVM type-signature letters for long/float/
  // boolean and need no escaping (only structural chars like `_`, `;`, `[` do).
  NATIVES['Java_arc_audio_Soloud_sourcePlay__J'] = async (lib, h) => playVoice(h, 1, 1, 0, src(h)?.defaultLoop ?? false);
  NATIVES['Java_arc_audio_Soloud_sourcePlay__JFFFZ'] = NATIVES['Java_arc_audio_Soloud_sourcePlay'];
  nativeAudio('sourceInaudible', async () => {});
  nativeAudio('sourceCount', async () => 0);
  nativeAudio('sourcePriority', async () => {});
  nativeAudio('sourceMinConcurrentInterrupt', async () => {});
  nativeAudio('sourceMaxConcurrent', async () => {});
  nativeAudio('sourceConcurrentGroup', async () => {});
  nativeAudio('sourceLoop', async (lib, h, loop) => { const s0 = src(h); if (s0) s0.defaultLoop = loop; }); // default used by sourcePlay(long) - the 1-arg overload, where JS receives `loop === undefined`
  nativeAudio('sourceSingleInstance', async (lib, h, single) => { const s0 = src(h); if (s0) s0.singleInstance = single; });
  nativeAudio('sourceStop', async (lib, h) => {
    for (const [id, v] of voices) if (v.sourceHandle === H(h)) { try { v.node.stop(); } catch (e) {} voices.delete(id); }
  });
  nativeAudio('sourceFilter', async () => {}); // attaches a DSP filter to a source - no-op, matches the other filter*Set stubs below (DSP effects deferred)
  nativeAudio('wavLoadFile', async (lib, path) => {
    console.warn('[stub-natives] Soloud.wavLoadFile called with a raw path (' + path + ') - only the byte-array loader (wavLoadBytes) is implemented, since that is the path Mindustry actually uses for asset loading. Returning an invalid handle.');
    return 0;
  });
  nativeAudio('streamLoadFile', async (lib, path) => NATIVES['Java_arc_audio_Soloud_wavLoadFile'](lib, path));
  nativeAudio('pauseDevice', async () => { if (actx.state === 'running') await actx.suspend(); return 0; });
  nativeAudio('resumeDevice', async () => { if (actx.state === 'suspended') await actx.resume(); return 0; });

  nativeAudio('idStop', async (lib, id) => { const v = voices.get(id); if (v) { try { v.node.stop(); } catch (e) {} voices.delete(id); } });
  nativeAudio('idVolume', async (lib, id, vol) => { const v = voices.get(id); if (v) v.gain.gain.value = vol; });
  nativeAudio('idGetVolume', async (lib, id) => voices.get(id)?.gain.gain.value || 0);
  nativeAudio('idPan', async (lib, id, pan) => { const v = voices.get(id); if (v) v.panner.pan.value = pan; });
  nativeAudio('idPitch', async (lib, id, pitch) => { const v = voices.get(id); if (v) v.node.playbackRate.value = pitch; });
  nativeAudio('idPause', async (lib, id, pause) => { const v = voices.get(id); if (v) v.gain.gain.value = pause ? 0 : (v._prevGain ?? 1); });
  nativeAudio('idGetPause', async () => false);
  nativeAudio('idProtected', async () => {});
  nativeAudio('idLooping', async (lib, id, loop) => { const v = voices.get(id); if (v) v.node.loop = loop; });
  nativeAudio('idGetLooping', async (lib, id) => voices.get(id)?.node.loop || false);
  nativeAudio('idSeek', async () => {});
  nativeAudio('idPosition', async () => 0);
  nativeAudio('idValid', async (lib, id) => voices.has(id));

  nativeAudio('busNew', async () => nextHandle++);
  nativeAudio('setGlobalFilter', async () => {});
  for (const filterStub of ['biquadSet','echoSet','lofiSet','flangerSet','waveShaperSet','bassBoostSet','robotizeSet','freeverbSet','filterFade','filterSet']) {
    nativeAudio(filterStub, async () => {});
  }
  for (const filterFactory of ['filterBiquad','filterEcho','filterLofi','filterFlanger','filterBassBoost','filterWaveShaper','filterRobotize','filterFreeverb']) {
    nativeAudio(filterFactory, async () => 0);
  }

  // =====================================================================
  // native-filedialogs - always "cancelled"
  // =====================================================================
  NATIVES['Java_arc_files_FileDialogs_openDialog'] = async () => null;
  NATIVES['Java_arc_files_FileDialogs_saveDialog'] = async () => null;

  global.STUB_NATIVES = NATIVES;
})(window);
