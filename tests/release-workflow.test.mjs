import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {execFileSync} from 'node:child_process';

const project=process.cwd(),adapter=path.join(project,'tools/prepare-release.mjs');
function fixture(){
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'tradebook-release-')),source=path.join(root,'source'),target=path.join(root,'target');
 const git=(dir,...args)=>execFileSync('git',['-C',dir,...args],{encoding:'utf8',stdio:'pipe'});
 const write=(dir,name,value)=>{const dest=path.join(dir,name);fs.mkdirSync(path.dirname(dest),{recursive:true});fs.writeFileSync(dest,value);};
 for(const dir of [source,target]){fs.mkdirSync(dir);write(dir,'.gitignore','.sites-runtime/\n');git(dir,'init','-b','main');}
 const identity={project_id:'existing-test-site',d1:'DB',r2:null},history={version:'private-test',accounts:[{account:'LFF05099999999999',data:'private sentinel'}]},notices=[{id:'private-test-notice',date:'2026-08-03',accounts:['LFF05099999999999'],kind:'hedging-profit-removal',amount:null,source:'Synthetic private sentinel'}];
 write(source,'.openai/hosting.json',JSON.stringify({d1:'DB',r2:null}));write(source,'data/initial-history.json',JSON.stringify({accounts:[]}));write(source,'data/firm-adjustments.json','[]');write(source,'lib/balance-adjustments.ts',"import firmNotices from '../data/firm-adjustments.json';\nexport const KNOWN_FIRM_ADJUSTMENTS=firmNotices;\n");write(source,'tools/check-public-source.mjs',fs.readFileSync(path.join(project,'tools/check-public-source.mjs')));
 write(target,'.openai/hosting.json',JSON.stringify(identity));write(target,'data/initial-history.json',JSON.stringify(history));write(target,'lib/balance-adjustments.ts','export const KNOWN_FIRM_ADJUSTMENTS: unknown[] = '+JSON.stringify(notices)+';\n');
 for(const dir of [source,target]){git(dir,'add','.');git(dir,'-c','user.name=Test','-c','user.email=test@example.invalid','commit','--no-gpg-sign','-m','test baseline');}
 return {source,target,identity,history,notices,git,write,run:(...extra)=>execFileSync(process.execPath,[adapter,'--source',source,'--target',target,...extra],{encoding:'utf8',stdio:'pipe'}),cleanup:()=>fs.rmSync(root,{recursive:true,force:true})};
}
test('release planning leaves files intact and applying preserves private identity, seed and legacy firm notices',()=>{
 const f=fixture();try{
  f.run();assert.equal(f.git(f.target,'status','--porcelain').trim(),'');assert.equal(fs.existsSync(path.join(f.target,'data/firm-adjustments.json')),false);
  f.run('--apply');for(const [name,expected] of [['.openai/hosting.json',f.identity],['data/initial-history.json',f.history],['data/firm-adjustments.json',f.notices]])assert.deepEqual(JSON.parse(fs.readFileSync(path.join(f.target,name),'utf8')),expected);
  assert.match(fs.readFileSync(path.join(f.target,'lib/balance-adjustments.ts'),'utf8'),/^import firmNotices/);assert.ok(fs.existsSync(path.join(f.target,'.sites-runtime/github-source-release.json')));
 }finally{f.cleanup();}
});
test('release preparation rejects a dirty target before changing private inputs',()=>{
 const f=fixture();try{f.write(f.target,'in-progress.txt','another session is working');assert.throws(()=>f.run('--apply'),/Checkout has changes/);assert.equal(fs.existsSync(path.join(f.target,'data/firm-adjustments.json')),false);assert.deepEqual(JSON.parse(fs.readFileSync(path.join(f.target,'data/initial-history.json'),'utf8')),f.history);}finally{f.cleanup();}
});
