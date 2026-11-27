// PURPOSE: Generate and validate the kiosk's fixed Hindi voice prompts locally.
import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { link, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const outputDir = resolve(here, '../app/src/main/res/raw');
const stagingRoot = resolve(here, '../build');
const elevenLabsCacheRoot = resolve(here, '../build/elevenlabs-voice-cache');
const voice = 'hi-IN-SwaraNeural';
const format = 'audio-24khz-48kbitrate-mono-mp3';
const elevenLabsModel = 'eleven_v4';
const elevenLabsFormat = 'mp3_44100_128';
const elevenLabsVoiceSettings = { stability: 0.5, similarity_boost: 0.75 };
const cues = [
  ['register_start', 'नमस्ते! अपनी अटेंडेंस ऐप का छह अंकों वाला कोड डालें।'],
  ['code_rejected', 'कोड जाँचें या ऐप से नया कोड लें।'],
  ['consent', 'स्क्रीन पर दी गई जानकारी पढ़ें। सहमत हों तो कैमरा शुरू करें।'],
  ['frame_face', 'अपना चेहरा स्क्रीन पर बने अंडाकार घेरे में रखें।'],
  ['closer', 'थोड़ा पास आइए।'],
  ['farther', 'थोड़ा पीछे हटिए।'],
  ['center', 'चेहरा घेरे के बीच में रखें।'],
  ['single_face', 'एक बार में एक ही व्यक्ति कैमरे के सामने आए।'],
  ['return_face', 'अपना चेहरा फिर से घेरे में लाएँ।'],
  ['straight', 'सीधे कैमरे में देखें।'],
  ['left', 'सिर थोड़ा बाईं ओर घुमाएँ।'],
  ['right', 'अब दाईं ओर घुमाएँ।'],
  ['up', 'ठुड्डी थोड़ी ऊपर उठाएँ।'],
  ['down', 'अब ठुड्डी थोड़ी नीचे करें।'],
  ['hold', 'अब सीधे देखें और एक पल स्थिर रहें।'],
  ['capture_retry', 'जानकारी फिर से पढ़ें। सहमत हों तो दोबारा कोशिश करें।'],
  ['checking', 'एक पल रुकिए। रजिस्ट्रेशन की पुष्टि हो रही है।'],
  ['registered', 'आपका रजिस्ट्रेशन हो गया। अब आप चेक-इन कर सकते हैं।'],
  ['already_registered', 'आपका चेहरा पहले से रजिस्टर है।'],
  ['checked_in', 'नमस्ते! आपका चेक-इन हो गया।'],
  ['checked_out', 'आपका चेक-आउट हो गया। धन्यवाद!'],
  ['already_in', 'आपका चेक-इन पहले ही हो चुका है।'],
  ['already_out', 'आपका चेक-आउट पहले ही हो चुका है।'],
  ['check_in_first', 'कृपया पहले चेक-इन करें।'],
];

const mpeg1Layer3Kbps = [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320];
const mpeg2Layer3Kbps = [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160];

export function inspectMp3(buffer, { sampleRate: requiredSampleRate = 24000, mono = true } = {}) {
  let offset = 0;
  if (buffer.length >= 10 && buffer.toString('ascii', 0, 3) === 'ID3') {
    const size = ((buffer[6] & 0x7f) << 21) | ((buffer[7] & 0x7f) << 14) |
      ((buffer[8] & 0x7f) << 7) | (buffer[9] & 0x7f);
    offset = 10 + size + ((buffer[5] & 0x10) ? 10 : 0);
  }
  let frameCount = 0;
  let durationSeconds = 0;
  let expectedVersion = null;
  let parsedSampleRate = null;
  while (offset + 4 <= buffer.length) {
    if (buffer[offset] !== 0xff || (buffer[offset + 1] & 0xe0) !== 0xe0) break;
    const versionBits = (buffer[offset + 1] >> 3) & 3;
    const layerBits = (buffer[offset + 1] >> 1) & 3;
    const bitrateIndex = (buffer[offset + 2] >> 4) & 15;
    const sampleIndex = (buffer[offset + 2] >> 2) & 3;
    const padding = (buffer[offset + 2] >> 1) & 1;
    const channelMode = buffer[offset + 3] >> 6;
    if (versionBits === 1 || layerBits !== 1 || bitrateIndex === 0 || bitrateIndex === 15 || sampleIndex === 3) break;
    const version = versionBits === 3 ? 1 : versionBits === 2 ? 2 : 2.5;
    if (expectedVersion !== null && version !== expectedVersion) throw new Error('Inconsistent MP3 frame versions');
    expectedVersion = version;
    const kbps = (version === 1 ? mpeg1Layer3Kbps : mpeg2Layer3Kbps)[bitrateIndex];
    const sampleRate = ([44100, 48000, 32000][sampleIndex]) / (version === 1 ? 1 : version === 2 ? 2 : 4);
    if (parsedSampleRate !== null && sampleRate !== parsedSampleRate) throw new Error('Inconsistent MP3 sample rates');
    parsedSampleRate = sampleRate;
    const frameLength = Math.floor((version === 1 ? 144 : 72) * kbps * 1000 / sampleRate) + padding;
    if (frameLength < 4 || offset + frameLength > buffer.length) throw new Error('Truncated MP3 frame');
    if (requiredSampleRate != null && sampleRate !== requiredSampleRate) {
      throw new Error('Expected 24 kHz MP3 audio');
    }
    if (mono && channelMode !== 3) throw new Error('Expected mono MP3 audio');
    frameCount++;
    durationSeconds += (version === 1 ? 1152 : 576) / sampleRate;
    offset += frameLength;
  }
  if (frameCount < 2) throw new Error('Not an MP3 Layer III frame stream');
  if (offset !== buffer.length && !(offset + 128 === buffer.length && buffer.toString('ascii', offset, offset + 3) === 'TAG')) {
    throw new Error('Unexpected trailing data after MP3 frames');
  }
  return {
    frames: frameCount,
    sampleRate: parsedSampleRate,
    durationSeconds,
  };
}

function target(cue) { return join(outputDir, `voice_${cue}.mp3`); }
function xmlEscape(text) {
  return text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;').replaceAll("'", '&apos;');
}
function reportCheck(cue, info) {
  console.log(`${cue}: ${info.durationSeconds.toFixed(2)}s, ${info.sampleRate} Hz, mono, ${info.frames} MP3 frames`);
}

async function check() {
  let failed = false;
  for (const [cue] of cues) {
    try { reportCheck(cue, inspectMp3(await readFile(target(cue)))); }
    catch { console.error(`${cue}: missing or invalid MP3`); failed = true; }
  }
  if (failed) process.exitCode = 1;
}

async function generateAzure() {
  const key = process.env.SPEECH_KEY;
  const region = process.env.SPEECH_REGION;
  if (!key || !region) {
    console.error('Set SPEECH_KEY and SPEECH_REGION in the process environment. Values are never displayed.');
    process.exitCode = 2;
    return;
  }
  if (!/^[a-z0-9-]{2,32}$/.test(region)) {
    console.error('SPEECH_REGION must be a region identifier containing lowercase letters, digits, and hyphens.');
    process.exitCode = 2;
    return;
  }
  const pending = [];
  await mkdir(outputDir, { recursive: true });
  for (const [cue] of cues) {
    try {
      reportCheck(cue, inspectMp3(await readFile(target(cue))));
    } catch (error) {
      if (error.code === 'ENOENT') pending.push(cue);
      else throw new Error(`Existing ${cue} asset is unreadable or invalid; replace it explicitly before generation.`);
    }
  }
  if (pending.length === 0) { console.log('All valid clips already exist; nothing generated.'); return; }

  await mkdir(stagingRoot, { recursive: true });
  const staging = await mkdtemp(join(stagingRoot, 'voice-staging-'));
  try {
    for (const cue of pending) {
      const text = cues.find(([id]) => id === cue)[1];
      const style = ['register_start', 'checked_in', 'checked_out', 'registered'].includes(cue)
        ? `<mstts:express-as style="empathetic">${xmlEscape(text)}</mstts:express-as>`
        : xmlEscape(text);
      const body = `<speak xmlns="http://www.w3.org/2001/10/synthesis" xmlns:mstts="https://www.w3.org/2001/mstts" version="1.0" xml:lang="hi-IN"><voice name="${voice}">${style}</voice></speak>`;
      const response = await fetch(`https://${region}.tts.speech.microsoft.com/cognitiveservices/v1`, {
        method: 'POST',
        headers: {
          'Ocp-Apim-Subscription-Key': key,
          'Content-Type': 'application/ssml+xml',
          'X-Microsoft-OutputFormat': format,
          'User-Agent': 'ELT-Attendance-Kiosk-Voice-Asset-Generator',
        },
        body,
        redirect: 'error',
        signal: AbortSignal.timeout(60_000),
      });
      if (!response.ok) {
        await response.body?.cancel();
        throw new Error(`Speech service request failed for cue ${cue} (HTTP ${response.status}); response body omitted.`);
      }
      const audio = Buffer.from(await response.arrayBuffer());
      inspectMp3(audio);
      const stagedPath = join(staging, `voice_${cue}.mp3`);
      await writeFile(stagedPath, audio, { flag: 'wx' });
      const finalPath = target(cue);
      try {
        await link(stagedPath, finalPath);
      } catch (error) {
        if (error.code !== 'EEXIST') throw error;
        try { inspectMp3(await readFile(finalPath)); }
        catch { throw new Error(`Could not safely publish ${cue}; an invalid asset appeared during generation.`); }
      }
      reportCheck(cue, inspectMp3(await readFile(finalPath)));
      await rm(stagedPath, { force: true });
    }
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}

function ffmpegPath() {
  return process.env.FFMPEG_PATH || 'ffmpeg';
}

export function preflightFfmpeg(executable = ffmpegPath()) {
  try {
    execFileSync(executable, ['-version'], { stdio: 'ignore', windowsHide: true });
    execFileSync(executable, [
      '-hide_banner', '-nostdin', '-v', 'error', '-f', 'lavfi', '-i', 'anullsrc=r=24000:cl=mono',
      '-t', '0.1', '-codec:a', 'libmp3lame', '-f', 'mp3', process.platform === 'win32' ? 'NUL' : '/dev/null',
    ], { stdio: 'ignore', windowsHide: true });
  } catch {
    throw new Error('ElevenLabs mode requires a working FFmpeg with libmp3lame. Set FFMPEG_PATH or add ffmpeg to PATH.');
  }
}

export function transcodeWithFfmpeg(executable, inputPath, outputPath) {
  execFileSync(executable, [
    '-hide_banner', '-nostdin', '-v', 'error', '-y', '-i', inputPath,
    '-map_metadata', '-1', '-vn', '-ac', '1', '-ar', '24000',
    '-codec:a', 'libmp3lame', '-b:a', '48k', outputPath,
  ], { stdio: 'ignore', windowsHide: true });
  execFileSync(executable, [
    '-hide_banner', '-nostdin', '-v', 'error', '-xerror', '-i', outputPath, '-f', 'null', '-',
  ], { stdio: 'ignore', windowsHide: true });
}

function elevenLabsCachePath(cacheRoot, voiceId, cue, text) {
  const signature = JSON.stringify({
    voiceId, cue, text, model: elevenLabsModel, format: elevenLabsFormat,
    voiceSettings: elevenLabsVoiceSettings,
  });
  const key = createHash('sha256').update(signature).digest('hex');
  return join(cacheRoot, key, `voice_${cue}.source.mp3`);
}

function normalizeVoiceName(name) {
  return name.trim().replace(/\s+/g, ' ').toLocaleLowerCase('en-US');
}

async function safeProviderFailure(response, service) {
  let detail;
  try { detail = await response.json(); }
  catch { await response.body?.cancel(); }
  const messages = [];
  const collect = value => {
    if (typeof value === 'string') messages.push(value.toLocaleLowerCase('en-US'));
    else if (Array.isArray(value)) value.forEach(collect);
    else if (value && typeof value === 'object') Object.values(value).forEach(collect);
  };
  collect(detail);
  const text = messages.join(' ');
  const allowlisted = [
    'missing_permissions', 'invalid_api_key', 'voice_not_found', 'model_not_found',
    'model_not_supported', 'quota_exceeded', 'rate_limit_exceeded', 'system_busy',
    'content_policy_violation', 'invalid_request',
  ];
  const category = allowlisted.find(code => text.includes(code))
    ?? (text.includes('permission') ? 'missing_permissions'
      : text.includes('api key') || text.includes('api_key') ? 'invalid_api_key'
        : text.includes('voice') && text.includes('not found') ? 'voice_not_found'
          : text.includes('model') && (text.includes('not found') || text.includes('not supported')) ? 'model_not_supported'
            : text.includes('quota') || text.includes('credit') ? 'quota_exceeded'
              : text.includes('rate limit') || text.includes('too many requests') ? 'rate_limit_exceeded'
                : text.includes('content') && text.includes('policy') ? 'content_policy_violation'
                  : undefined);
  const action = {
    missing_permissions: 'Grant this key text-to-speech access.',
    invalid_api_key: 'Check the configured API key.',
    voice_not_found: 'Verify the supplied voice ID is available to this account.',
    model_not_found: 'Verify model access for this account.',
    model_not_supported: 'Confirm the supplied voice supports eleven_v4; do not switch voices or models automatically.',
    quota_exceeded: 'Check the account credit quota.',
    rate_limit_exceeded: 'Wait before retrying the batch.',
    system_busy: 'Retry later without repeating any completed cues.',
    content_policy_violation: 'Review the fixed cue request with the provider.',
    invalid_request: 'Review the request format with the provider.',
  }[category] ?? 'Review the provider request status before retrying.';
  return `${service} request failed for cue (HTTP ${response.status}; ${category ?? 'provider_error'}). ${action}`;
}

export async function resolveElevenLabsVoiceId({ key, voiceId, fetchImpl = fetch }) {
  if (voiceId) {
    if (!/^[A-Za-z0-9_-]{2,128}$/.test(voiceId)) {
      throw new Error('ELEVENLABS_VOICE_ID must contain only letters, digits, underscores, or hyphens.');
    }
    return voiceId;
  }
  const searchName = 'Monika Sogam - Lively E-Com Support';
  const url = new URL('https://api.elevenlabs.io/v2/voices');
  url.searchParams.set('search', searchName);
  url.searchParams.set('page_size', '100');
  const response = await fetchImpl(url, {
    headers: { 'xi-api-key': key, Accept: 'application/json' },
    redirect: 'error',
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error(`ElevenLabs voice lookup failed (HTTP ${response.status}); response body omitted.`);
  }
  let matches;
  try {
    const data = await response.json();
    matches = Array.isArray(data.voices)
      ? data.voices.filter(item => typeof item.name === 'string' && normalizeVoiceName(item.name) === normalizeVoiceName(searchName))
      : [];
  } catch {
    throw new Error('ElevenLabs voice lookup returned invalid JSON.');
  }
  if (matches.length !== 1 || typeof matches[0]?.voice_id !== 'string' || !/^[A-Za-z0-9_-]{2,128}$/.test(matches[0].voice_id)) {
    throw new Error(matches.length === 0
      ? 'No exact voice name match was found. Set ELEVENLABS_VOICE_ID explicitly.'
      : 'The voice name matched multiple voices. Set ELEVENLABS_VOICE_ID explicitly.');
  }
  return matches[0].voice_id;
}

export async function generateElevenLabs({
  key = process.env.ELEVENLABS_API_KEY,
  voiceId = process.env.ELEVENLABS_VOICE_ID,
  outputDirectory = outputDir,
  cacheRoot = elevenLabsCacheRoot,
  fetchImpl = fetch,
  preflight = preflightFfmpeg,
  transcode = transcodeWithFfmpeg,
  executable = ffmpegPath(),
} = {}) {
  await mkdir(outputDirectory, { recursive: true });
  const pending = [];
  for (const [cue] of cues) {
    try {
      reportCheck(cue, inspectMp3(await readFile(join(outputDirectory, `voice_${cue}.mp3`))));
    } catch (error) {
      if (error.code === 'ENOENT') pending.push(cue);
      else throw new Error(`Existing ${cue} asset is unreadable or invalid; replace it explicitly before generation.`);
    }
  }
  if (pending.length === 0) { console.log('All valid clips already exist; nothing generated.'); return; }
  preflight(executable);
  if (!voiceId && !key) {
    throw new Error('Set ELEVENLABS_API_KEY to look up the exact configured voice, or set ELEVENLABS_VOICE_ID with a key for synthesis.');
  }
  voiceId = await resolveElevenLabsVoiceId({ key, voiceId, fetchImpl });
  await mkdir(stagingRoot, { recursive: true });
  await mkdir(cacheRoot, { recursive: true });
  const staging = await mkdtemp(join(stagingRoot, 'voice-elevenlabs-'));
  try {
    for (const cue of pending) {
      const text = cues.find(([id]) => id === cue)[1];
      const cachePath = elevenLabsCachePath(cacheRoot, voiceId, cue, text);
      let sourceAudio;
      try {
        sourceAudio = await readFile(cachePath);
        inspectMp3(sourceAudio, { sampleRate: null, mono: false });
      } catch (error) {
        if (error.code !== 'ENOENT') {
          throw new Error(`Cached ElevenLabs audio for ${cue} is invalid or unreadable; inspect or remove that ignored build cache file.`);
        }
        if (!key) throw new Error(`Set ELEVENLABS_API_KEY to generate missing cue ${cue}. Cached audio for this cue was not found.`);
        const response = await fetchImpl(
          `https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(voiceId)}?output_format=${elevenLabsFormat}`,
          {
            method: 'POST',
            headers: { 'xi-api-key': key, 'Content-Type': 'application/json', Accept: 'audio/mpeg' },
            body: JSON.stringify({
              text, model_id: elevenLabsModel, language_code: 'hi', voice_settings: elevenLabsVoiceSettings,
            }),
            redirect: 'error',
            signal: AbortSignal.timeout(60_000),
          },
        );
        if (!response.ok) {
          throw new Error(await safeProviderFailure(response, `ElevenLabs ${elevenLabsModel} ${cue}`));
        }
        sourceAudio = Buffer.from(await response.arrayBuffer());
        inspectMp3(sourceAudio, { sampleRate: null, mono: false });
        await mkdir(dirname(cachePath), { recursive: true });
        const cacheTemp = join(dirname(cachePath), `.voice_${cue}.${randomUUID()}.tmp`);
        await writeFile(cacheTemp, sourceAudio, { flag: 'wx' });
        try { await link(cacheTemp, cachePath); }
        catch (error) {
          if (error.code !== 'EEXIST') throw error;
          sourceAudio = await readFile(cachePath);
          inspectMp3(sourceAudio, { sampleRate: null, mono: false });
        } finally { await rm(cacheTemp, { force: true }); }
      }

      const sourcePath = join(staging, `voice_${cue}.source.mp3`);
      const encodedPath = join(staging, `voice_${cue}.mp3`);
      await writeFile(sourcePath, sourceAudio, { flag: 'wx' });
      await transcode(executable, sourcePath, encodedPath);
      inspectMp3(await readFile(encodedPath));
      const finalPath = join(outputDirectory, `voice_${cue}.mp3`);
      try { await link(encodedPath, finalPath); }
      catch (error) {
        if (error.code !== 'EEXIST') throw error;
        try { inspectMp3(await readFile(finalPath)); }
        catch { throw new Error(`Could not safely publish ${cue}; an invalid asset appeared during generation.`); }
      }
      reportCheck(cue, inspectMp3(await readFile(finalPath)));
    }
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}

const isMain = process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
if (isMain && process.argv.includes('--check')) await check();
else if (isMain && process.argv.includes('--help')) {
  console.log('Usage: node apps/android/tools/generate-kiosk-voice.mjs [--check | --elevenlabs]');
  console.log('--check validates MP3 frame headers, sample rate, channel mode, and duration for all 24 clips.');
  console.log('This is not a full codec decode or device playback check.');
  console.log('No-flag generation uses Azure Speech with SPEECH_KEY and SPEECH_REGION.');
  console.log('--elevenlabs uses ELEVENLABS_API_KEY and ELEVENLABS_VOICE_ID; FFmpeg with libmp3lame is required.');
} else if (isMain && process.argv.includes('--elevenlabs')) {
  await generateElevenLabs().catch(error => {
    console.error(error.message);
    process.exitCode = 1;
  });
} else if (isMain) await generateAzure();

export { cues };
