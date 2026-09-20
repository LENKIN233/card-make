import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {execFileSync, spawnSync} from 'node:child_process';
import test from 'node:test';
import {materializeTrustedMediaAssets} from './materialize_trusted_media_assets.mjs';

function fixture(t, track) {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'media-assets-'));
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const sourceRoot=path.join(root,'cache'),destinationRoot=path.join(root,'repository');
  fs.mkdirSync(sourceRoot);fs.mkdirSync(destinationRoot);
  const count=track==='cet4'?301:328;
  const assets=Array.from({length:count},(_,index)=>{
    const id=String((track==='cet4'?0:100000)+index+1).padStart(6,'0');
    const relative=`ai_tts/${track}/${id.slice(0,4)}/${id}-v2.mp3`;
    const bytes=Buffer.from(`fixture-media-${id}`),sha=createHash('sha256').update(bytes).digest('hex');
    for(const dir of [sourceRoot,destinationRoot])fs.mkdirSync(path.dirname(path.join(dir,relative)),{recursive:true});
    fs.writeFileSync(path.join(sourceRoot,relative),bytes);
    fs.writeFileSync(path.join(destinationRoot,relative),`version https://git-lfs.github.com/spec/v1\noid sha256:${sha}\nsize ${bytes.length}\n`);
    return {card_id:id,asset_path:relative,file_sha256:sha,size_bytes:bytes.length};
  });
  const git=(...args)=>execFileSync('git',['-c','user.name=Fixture','-c','user.email=fixture@example.test',...args],{cwd:destinationRoot,stdio:'ignore'});
  git('init','-q');git('add','.');git('commit','-qm','exact pointers');
  fs.writeFileSync(path.join(sourceRoot,'historical-unreferenced.mp3'),'retained history');
  return {sourceRoot,destinationRoot,track,document:{schema_version:'trusted-media-audio-manifest.v1',track,asset_count:count,assets}};
}
for(const track of ['cet4','cet6'])test(`${track} copies only exact current assets while retaining historical cache`,t=>{
  const args=fixture(t,track);const result=materializeTrustedMediaAssets(args);
  assert.equal(result.materialized_assets,args.document.asset_count);
  for(const entry of args.document.assets)assert.deepEqual(fs.readFileSync(path.join(args.destinationRoot,entry.asset_path)),fs.readFileSync(path.join(args.sourceRoot,entry.asset_path)));
  assert.equal(fs.existsSync(path.join(args.destinationRoot,'historical-unreferenced.mp3')),false);
});
test('a corrupt late asset causes no partial writes',t=>{
  const args=fixture(t,'cet6');const first=path.join(args.destinationRoot,args.document.assets[0].asset_path);const before=fs.readFileSync(first);
  fs.writeFileSync(path.join(args.sourceRoot,args.document.assets.at(-1).asset_path),'wrong');
  assert.throws(()=>materializeTrustedMediaAssets(args),/source media bytes/);
  assert.deepEqual(fs.readFileSync(first),before);
});
test('a symlink cannot replace exact cached media',t=>{
  const args=fixture(t,'cet4');const a=path.join(args.sourceRoot,args.document.assets[0].asset_path),b=path.join(args.sourceRoot,args.document.assets[1].asset_path);
  fs.unlinkSync(a);fs.symlinkSync(b,a);
  assert.throws(()=>materializeTrustedMediaAssets(args),/symlink/);
});
test('the asset document cannot disagree with its immutable LFS pointer',t=>{
  const args=fixture(t,'cet6');const entry=args.document.assets[0];entry.file_sha256='a'.repeat(64);
  assert.throws(()=>materializeTrustedMediaAssets(args),/immutable LFS pointer/);
});
test('unknown or cross-track scopes fail before filesystem access',()=>{
  for(const track of ['__proto__','cet8'])assert.throws(()=>materializeTrustedMediaAssets({track,document:{track}}),/not registered/);
  assert.throws(()=>materializeTrustedMediaAssets({track:'cet6',document:{track:'cet4'}}),/does not match/);
  assert.throws(()=>materializeTrustedMediaAssets({track:'cet6',document:{schema_version:'audio-perceptual-worklist.v3',track:'cet6',entries:Array(301).fill({audio:{}})}}),/wrong asset count/);
});

test('the workflow accepts hydrated audio from both tracks and detects any changed bytes', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'media-checkout-'));
  t.after(() => fs.rmSync(root, {recursive: true, force: true}));
  const env = {...process.env, GIT_CONFIG_GLOBAL: os.devNull,
    GIT_CONFIG_SYSTEM: os.devNull, GIT_CONFIG_NOSYSTEM: '1'};
  const git = (...args) => execFileSync('git', [
    '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', ...args,
  ], {cwd: root, env, stdio: 'pipe'});
  const paths = ['ai_tts/cet4/0000/000001-v2.mp3', 'ai_tts/cet6/1000/100001-v2.mp3'];
  const media = paths.map(p => Buffer.from(`fixture bytes for ${p}`));
  git('init', '-q');
  fs.writeFileSync(path.join(root, '.gitattributes'), 'ai_tts/** filter=lfs -text\n');
  fs.writeFileSync(path.join(root, 'source.json'), '{"scope":"both"}\n');
  for (const [index, relative] of paths.entries()) {
    fs.mkdirSync(path.dirname(path.join(root, relative)), {recursive: true});
    fs.writeFileSync(path.join(root, relative),
      `version https://git-lfs.github.com/spec/v1\noid sha256:${createHash('sha256').update(media[index]).digest('hex')}\nsize ${media[index].length}\n`);
  }
  git('add', '.'); git('commit', '-qm', 'immutable source and LFS pointers');
  const head = git('rev-parse', 'HEAD').toString().trim();
  for (const [index, relative] of paths.entries()) fs.writeFileSync(path.join(root, relative), media[index]);
  // Reproduce the CET6 run failure: the old guard only exempts current-track audio.
  assert.equal(spawnSync('git', ['diff-index', '--quiet', head, '--', '.', ':(exclude)ai_tts/cet6'],
    {cwd: root, env}).status, 1);
  const check = () => spawnSync('git', ['-c', 'filter.lfs.process=git-lfs filter-process',
    '-c', 'filter.lfs.required=true', 'diff', '--quiet', '--no-ext-diff', '--no-textconv', head, '--', '.'],
  {cwd: root, env, encoding: 'utf8'});
  const clean = check();
  assert.equal(clean.status, 0, clean.stderr);
  for (const [index, relative] of paths.entries()) {
    fs.appendFileSync(path.join(root, relative), 'corrupt');
    assert.equal(check().status, 1, `must detect changed ${relative}`);
    fs.writeFileSync(path.join(root, relative), media[index]);
  }
  fs.writeFileSync(path.join(root, 'source.json'), '{"scope":"tampered"}\n');
  assert.equal(check().status, 1, 'must also detect non-media source changes');
});
