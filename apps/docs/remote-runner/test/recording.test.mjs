import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { transcribeAudio } from '../engine.mjs';
import { RECORDING_LIMITS, transcribeRecording } from '../recording.mjs';
import { validateAudioSnapshot, verifyAudioSnapshot } from '../snapshot.mjs';

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
async function fixture(t, configs=[{},{}]) {
  const root=await mkdtemp(join(tmpdir(),'niho-recording-test-'));
  await chmod(root,0o700);
  t.after(()=>rm(root,{recursive:true,force:true}));
  const workRoot=join(root,'work'); await mkdir(workRoot,{mode:0o700});
  const audio=[];
  for(let i=0;i<configs.length;i++) {
    const bytes=Buffer.alloc(44); bytes.write('RIFF',0); bytes.writeUInt32LE(36,4); bytes.write('WAVE',8); bytes[12]=i;
    const inputPath=join(root,`source-${i}.not-an-extension`);
    await writeFile(inputPath,bytes,{mode:0o600});
    audio.push({inputPath,snapshot:{bytes:bytes.length,sha256:sha256(bytes)}});
  }
  const sidecarPath=join(root,'speech');
  const audit=join(root,'audit.jsonl');
  await writeFile(sidecarPath,`#!${process.execPath}
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
const configs=${JSON.stringify(configs)};
const args=process.argv.slice(2), cmd=args[0];
const arg=k=>args[args.indexOf(k)+1];
const emit=v=>process.stdout.write(JSON.stringify(v)+'\\n');
const input=['convert','diarize','silence','transcribe'].includes(cmd)?readFileSync(arg('--input')):undefined;
const id=input?.[12]??0, config=configs[id], durationSec=config.durationSec??95;
appendFileSync(${JSON.stringify(audit)},JSON.stringify({cmd,id})+'\\n',{mode:384});
if(cmd==='version') emit({name:'niho-speech',version:'0.2.0'});
if(cmd==='convert') { writeFileSync(arg('--output'),input); emit({durationSec}); }
if(cmd==='diarize') { writeFileSync(arg('--output'),JSON.stringify({version:1,duration:durationSec,turns:[{start:0,end:durationSec,id:1}]}),{mode:384}); emit({ok:true,turns:1}); }
if(cmd==='silence') emit({durationSec,cuts:[]});
if(cmd==='transcribe') {
  if(config.hang) { process.on('SIGTERM',()=>{}); setInterval(()=>{},1000); }
  else if(config.error) emit({type:'error',code:'input_unreadable',message:'private message'});
  else {
    const segments=config.segments??[{start:1.25,end:2,text:config.text??('file '+id)}];
    for(const s of segments) {
      const event={type:'segment',...s};
      if(args.includes('--speaker-map')) event.speaker=Number.isSafeInteger(s.speaker)?s.speaker:1;
      emit(event);
    }
    emit({type:'done',segments:segments.length,durationMs:7});
  }
}
`,{mode:0o700});
  const options={audio,sidecarPath,workRoot,limits:{monitorMs:10,killGraceMs:30}};
  const log=async()=>{
    try {
      const lines=(await readFile(audit,'utf8')).split('\n');
      // The sidecar can be appending the last record while the cancellation test polls.
      lines.pop();
      return lines.map(JSON.parse);
    }
    catch(error) { if(error.code==='ENOENT')return []; throw error; }
  };
  const clean=async()=>{
    assert.deepEqual(await readdir(workRoot),[]);
    for(const entry of audio) assert.equal(sha256(await readFile(entry.inputPath)),entry.snapshot.sha256);
  };
  return {options,log,clean};
}

async function rejectsCode(promise,code) {
  await assert.rejects(promise,error=>error.code===code && error.message===code);
}

test('snapshot fields are frozen; duration is optional; comparison checks actual bytes and hash',()=>{
  const snapshot={sha256:'a'.repeat(64),bytes:44};
  const frozen=validateAudioSnapshot(snapshot);
  assert.equal(Object.isFrozen(frozen),true);
  snapshot.bytes=1;
  assert.equal(frozen.bytes,44);
  assert.deepEqual(verifyAudioSnapshot(frozen,{sha256:'a'.repeat(64),bytes:44}),frozen);
  assert.throws(()=>verifyAudioSnapshot(frozen,{sha256:'b'.repeat(64),bytes:44}),{code:'snapshot_mismatch'});
  for(const invalid of [undefined,{}, {...frozen,bytes:0}, {...frozen,bytes:1.5}, {...frozen,sha256:'not a hash'},
    {...frozen,durationSec:null}, {...frozen,durationSec:21600.01}]) {
    assert.throws(()=>validateAudioSnapshot(invalid),{code:'snapshot_invalid'});
  }
});

test('snapshot accepts every C1 audio size up to exactly 2 GiB (the 1.84 GiB interview AIFC included) and rejects one byte more',()=>{
  const GiB=1024**3;
  for(const bytes of [1,GiB,GiB+1,1_975_615_488,2*GiB]) {
    assert.equal(validateAudioSnapshot({sha256:'a'.repeat(64),bytes}).bytes,bytes);
  }
  for(const bytes of [2*GiB+1,Number.MAX_SAFE_INTEGER,2*GiB+0.5]) {
    assert.throws(()=>validateAudioSnapshot({sha256:'a'.repeat(64),bytes}),{code:'snapshot_invalid'});
  }
});

test('single-file engine rejects snapshot byte/hash mismatch before every sidecar command',async t=>{
  const f=await fixture(t,[{}]);
  const entry=f.options.audio[0];
  for(const expectedSource of [{...entry.snapshot,bytes:43},{...entry.snapshot,sha256:'0'.repeat(64)}]) {
    await rejectsCode(transcribeAudio({...f.options,inputPath:entry.inputPath,expectedSource}),'snapshot_mismatch');
    assert.deepEqual(await f.log(),[]);
    await f.clean();
  }
});

test('recording merges ordered audio using actual durations and hashes the UTF-8 candidate',async t=>{
  const f=await fixture(t,[{durationSec:70.5,text:' 一つ目。\n 本文 '},{durationSec:65.25,text:'二つ目。'}]);
  // An old declared estimate is not used as the next file's actual offset.
  f.options.audio[0].snapshot.durationSec=10;
  const result=await transcribeRecording(f.options);
  assert.equal(result.durationSec,135.75);
  assert.equal(result.processingMs,14);
  assert.deepEqual(result.files.map(file=>file.offsetSec),[0,70.5]);
  assert.deepEqual(result.segments.map(s=>[s.start,s.end]),[[1.25,2],[71.75,72.5]]);
  assert.equal(result.markdown,'[00:00:01] 一つ目。 本文\n\n[00:01:11] 二つ目。\n');
  assert.equal(result.candidate.bytes,Buffer.byteLength(result.markdown));
  assert.equal(result.candidate.sha256,sha256(result.markdown));
  assert.deepEqual(result.files.map(file=>file.source.sha256),f.options.audio.map(entry=>entry.snapshot.sha256));
  assert.ok(result.files.every(file=>file.engine.version==='0.2.0'));
  await f.clean();
});

test('複数ファイルの話者番号は Part 見出しでファイル単位と明示する',async t=>{
  const f=await fixture(t,[{durationSec:70.5,text:'一つ目',segments:[{start:1.25,end:2,text:'一つ目',speaker:2}]},{durationSec:65.25,text:'二つ目'}]);
  const result=await transcribeRecording({...f.options,speakerMode:'auto'});
  assert.equal(result.markdown,'## Part 1: 音声1\n\n[00:00:01] 話者2: 一つ目\n\n## Part 2: 音声2\n\n[00:01:11] 話者1: 二つ目\n');
  assert.deepEqual(result.segments.map(segment=>segment.speaker),[2,1]);
  assert.equal((await f.log()).filter(row=>row.cmd==='diarize').length,2);
  await f.clean();
});

test('recording rejects empty/too many files, external URLs, and declared duration overflow before sidecar',async t=>{
  const f=await fixture(t);
  for(const [audio,code] of [
    [[], 'recording_file_limit'],
    [Array.from({length:13},()=>f.options.audio[0]),'recording_file_limit'],
    [[{...f.options.audio[0],inputPath:'https://private.invalid/audio'}],'invalid_configuration'],
    [f.options.audio.map(entry=>({...entry,snapshot:{...entry.snapshot,durationSec:10800.01}})),'duration_limit'],
  ]) {
    await rejectsCode(transcribeRecording({...f.options,audio}),code);
    assert.deepEqual(await f.log(),[]);
    await f.clean();
  }
  assert.equal(RECORDING_LIMITS.maxFiles,12);
  await rejectsCode(transcribeRecording({...f.options,recordingLimits:{maxFiles:13}}),'invalid_configuration');
});

test('recording accepts exactly six decoded hours and refuses actual overflow before that file is recognized',async t=>{
  const valid=await fixture(t,[{durationSec:10800},{durationSec:10800}]);
  const result=await transcribeRecording(valid.options);
  assert.equal(result.durationSec,21600);
  assert.equal(result.segments[1].start,10801.25);
  await valid.clean();
  const over=await fixture(t,[{durationSec:10800},{durationSec:10800.01}]);
  await rejectsCode(transcribeRecording(over.options),'duration_limit');
  assert.deepEqual((await over.log()).filter(a=>a.cmd==='transcribe').map(a=>a.id),[0]);
  await over.clean();
});

test('aggregate checks every actual source before recognizing it and cleans earlier attempts',async t=>{
  const f=await fixture(t);
  const original=f.options.audio[1].snapshot;
  const audio=f.options.audio.map((entry,i)=>i?{...entry,snapshot:{...original,sha256:'0'.repeat(64)}}:entry);
  await rejectsCode(transcribeRecording({...f.options,audio}),'snapshot_mismatch');
  assert.deepEqual((await f.log()).filter(a=>a.cmd==='version').length,1);
  assert.deepEqual((await f.log()).filter(a=>a.cmd==='transcribe').map(a=>a.id),[0]);
  await f.clean();
});

test('UTF-8 candidate limit and segment cap apply to the whole recording',async t=>{
  const utf8=await fixture(t,[{text:'あああ'},{text:'いいい'}]);
  // Each standalone paragraph fits in 30 bytes, the combined candidate does not.
  await rejectsCode(transcribeRecording({...utf8.options,recordingLimits:{maxCandidateBytes:30}}),'candidate_limit');
  await utf8.clean();
  const many=await fixture(t);
  await rejectsCode(transcribeRecording({...many.options,recordingLimits:{maxSegments:1}}),'output_limit');
  assert.equal((await many.log()).filter(a=>a.cmd==='transcribe').length,1);
  await many.clean();
  const single=await fixture(t,[{text:'あ'.repeat(10)}]);
  const entry=single.options.audio[0];
  await rejectsCode(transcribeAudio({...single.options,inputPath:entry.inputPath,limits:{maxCandidateBytes:30}}),'candidate_limit');
  await single.clean();
});

test('failure/cancel on a later file leaves every attempt cleaned and caller audio intact',async t=>{
  const failed=await fixture(t,[{},{error:true}]);
  await rejectsCode(transcribeRecording(failed.options),'input_invalid');
  await failed.clean();
  const stopped=await fixture(t,[{},{hang:true}]);
  const controller=new AbortController();
  const pending=transcribeRecording({...stopped.options,signal:controller.signal});
  for(let i=0;i<1000;i++) {
    if((await stopped.log()).some(a=>a.cmd==='transcribe'&&a.id===1)) break;
    await new Promise(resolve=>setTimeout(resolve,10));
  }
  controller.abort();
  await rejectsCode(pending,'cancelled');
  await stopped.clean();
});


test('lower core duration/text/segment limits also constrain the whole recording',async t=>{
  for(const [limits,configs,code] of [
    [{maxCandidateBytes:30},[{text:'あああ'},{text:'いいい'}],'candidate_limit'],
    [{maxSegments:1},[{},{}],'output_limit'],
    [{maxDurationSec:150},[{},{}],'duration_limit'],
  ]) {
    const f=await fixture(t,configs);
    await rejectsCode(transcribeRecording({...f.options,limits:{...f.options.limits,...limits}}),code);
    await f.clean();
  }
});
