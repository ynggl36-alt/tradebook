import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
function fixture(code,asset=true){
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'tradebook-worker-')),directory=path.join(root,'_next/static');fs.mkdirSync(directory,{recursive:true});
  fs.writeFileSync(path.join(directory,'page.js'),code);
  if(asset)fs.writeFileSync(path.join(directory,'trendline-worker-synthetic.js'),'self.onmessage=()=>{};');
  return root;
}
function check(root){return spawnSync(process.execPath,['tools/check-worker-assets.mjs',root],{encoding:'utf8'});}
test('production worker guard executes the emitted constructor and rejects a file-origin URL even when the asset exists',()=>{
  const root=fixture('function build(){return new Worker(new URL("/_next/static/trendline-worker-synthetic.js","file:///ROOT/app/client.ts"),{type:"module"});}');
  try{const result=check(root);assert.notEqual(result.status,0);assert.match(result.stderr,/dashboard HTTPS origin/);}finally{fs.rmSync(root,{recursive:true});}
});
test('production worker guard accepts a same-origin emitted constructor and rejects a missing packaged asset',()=>{
  const root=fixture('function build(options){return new Worker("/_next/static/trendline-worker-synthetic.js",{name:options?.name});}');
  try{assert.equal(check(root).status,0);fs.unlinkSync(path.join(root,'_next/static/trendline-worker-synthetic.js'));const missing=check(root);assert.notEqual(missing.status,0);assert.match(missing.stderr,/no packaged browser asset/);}finally{fs.rmSync(root,{recursive:true});}
});
test('production worker guard cannot pass silently when no constructor was examined',()=>{
  const root=fixture('console.log("no worker constructor");');
  try{const result=check(root);assert.notEqual(result.status,0);assert.match(result.stderr,/No emitted trendline Worker constructor/);}finally{fs.rmSync(root,{recursive:true});}
});
