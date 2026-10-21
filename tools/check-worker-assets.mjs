import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';

// Execute the actual emitted Worker constructor, not a source-pattern proxy.
// Vinext may rewrite import.meta.url to a build-machine file URL; a bundled
// worker file alone does not prove that a browser will request it correctly.
const root=path.resolve(process.argv[2]||'dist/client');
const origin='https://journal.example.test';
function files(directory){return fs.readdirSync(directory,{withFileTypes:true}).flatMap(entry=>entry.isDirectory()?files(path.join(directory,entry.name)):[path.join(directory,entry.name)]);}
let constructors=0;const assets=new Set();
for(const filename of files(root).filter(f=>f.endsWith('.js'))){
  const source=fs.readFileSync(filename,'utf8');if(!source.includes('trendline-worker-'))continue;
  const parsed=ts.createSourceFile(filename,source,ts.ScriptTarget.Latest,true,ts.ScriptKind.JS);
  function visit(node){
    if(ts.isNewExpression(node)&&node.expression.getText(parsed)==='Worker'&&node.arguments?.[0]?.getText(parsed).includes('trendline-worker-')){
      let requested;
      class WorkerProbe{constructor(url){requested=url;}}
      // Optional wrapper parameters (e.g. the worker name) are undefined.
      const globals=new Proxy({Worker:WorkerProbe,URL},{has:()=>true,get:(object,key)=>object[key]});
      new Function('globals','with(globals){return '+node.getText(parsed)+';}')(globals);
      const url=new URL(String(requested),origin);
      assert.equal(url.origin,origin,'Trendline worker must resolve to the dashboard HTTPS origin, not a build-machine file URL.');
      assert.match(url.pathname,/^\/_next\/static\/trendline-worker-[a-zA-Z0-9_-]+\.js$/,'Unexpected worker asset path.');
      const asset=path.join(root,url.pathname);
      assert.ok(fs.existsSync(asset)&&fs.statSync(asset).size>0,'The emitted worker URL has no packaged browser asset: '+url.pathname);
      constructors++;assets.add(url.pathname);
    }
    ts.forEachChild(node,visit);
  }
  visit(parsed);
}
assert.ok(constructors>0,'No emitted trendline Worker constructor was checked.');
console.log('Worker asset check passed: '+constructors+' emitted constructor(s), '+assets.size+' packaged same-origin asset(s).');
