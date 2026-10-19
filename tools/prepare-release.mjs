import fs from 'node:fs';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import ts from 'typescript';

// This adapter only prepares an existing owner-controlled Sites checkout.
// It never publishes, contacts a database, or receives deployment credentials.
const args=process.argv.slice(2),value=flag=>{const i=args.indexOf(flag);return i<0?null:args[i+1];};
const sourceArg=value('--source'),targetArg=value('--target'),apply=args.includes('--apply');
if(!sourceArg||!targetArg||args.some((arg,i)=>!['--source','--target','--apply'].includes(arg)&&!['--source','--target'].includes(args[i-1])))throw Error('Usage: prepare-release.mjs --source <clean GitHub checkout> --target <clean opened Sites checkout> [--apply]');
const source=fs.realpathSync(sourceArg),target=fs.realpathSync(targetArg);
if(source===target||source.startsWith(target+path.sep)||target.startsWith(source+path.sep))throw Error('Use separate, non-nested source and target checkouts.');
const git=(dir,args)=>execFileSync('git',['-C',dir,...args],{encoding:'utf8'}).trim();
for(const dir of [source,target]){if(fs.realpathSync(git(dir,['rev-parse','--show-toplevel']))!==dir)throw Error('Expected a repository root: '+dir);if(git(dir,['status','--porcelain']))throw Error('Checkout has changes; resolve them first: '+dir);}
if(git(source,['branch','--show-current'])!=='main')throw Error('Release only the reviewed main branch.');
execFileSync(process.execPath,[path.join(source,'tools/check-public-source.mjs')],{cwd:source,stdio:'inherit'});
const manifest=JSON.parse(fs.readFileSync(path.join(target,'.openai/hosting.json'),'utf8'));
if(typeof manifest.project_id!=='string'||!manifest.project_id)throw Error('The target has no existing Sites project identity. Open the existing Site first.');
const privateSeed=fs.readFileSync(path.join(target,'data/initial-history.json'),'utf8'),noticePath=path.join(target,'data/firm-adjustments.json');
let notices;
if(fs.existsSync(noticePath))notices=JSON.parse(fs.readFileSync(noticePath,'utf8'));
else{
 const file=ts.createSourceFile('balance-adjustments.ts',fs.readFileSync(path.join(target,'lib/balance-adjustments.ts'),'utf8'),ts.ScriptTarget.Latest,true);let initializer;
 const find=node=>{if(ts.isVariableDeclaration(node)&&ts.isIdentifier(node.name)&&node.name.text==='KNOWN_FIRM_ADJUSTMENTS')initializer=node.initializer;ts.forEachChild(node,find);};find(file);
 function literal(node){
  if(!node)throw Error('Private notices need a JSON file or a literal legacy array.');
  if(ts.isArrayLiteralExpression(node))return node.elements.map(literal);
  if(ts.isObjectLiteralExpression(node))return Object.fromEntries(node.properties.map(property=>{if(!ts.isPropertyAssignment(property)||(!ts.isIdentifier(property.name)&&!ts.isStringLiteral(property.name)))throw Error('Non-literal private notice property.');return [property.name.text,literal(property.initializer)];}));
  if(ts.isStringLiteral(node)||ts.isNoSubstitutionTemplateLiteral(node))return node.text;
  if(ts.isNumericLiteral(node))return Number(node.text);
  if(node.kind===ts.SyntaxKind.NullKeyword)return null;
  if(node.kind===ts.SyntaxKind.TrueKeyword)return true;
  if(node.kind===ts.SyntaxKind.FalseKeyword)return false;
  throw Error('Legacy private notices contain an expression; provide reviewed JSON instead.');
 }
 notices=literal(initializer);
}
if(!Array.isArray(notices)||notices.some(row=>!row||typeof row.id!=='string'||typeof row.date!=='string'||!Array.isArray(row.accounts)||row.kind!=='hedging-profit-removal'||row.amount!==null))throw Error('Unexpected private notice format.');
const protectedFiles=new Set(['.openai/hosting.json','data/initial-history.json','data/firm-adjustments.json']);
const files=execFileSync('git',['-C',source,'ls-files','-z'],{encoding:'utf8'}).split('\0').filter(Boolean).filter(name=>!protectedFiles.has(name));
for(const name of files){const src=path.join(source,name),dest=path.join(target,name);if(!dest.startsWith(target+path.sep)||fs.lstatSync(src).isSymbolicLink())throw Error('Unsafe source path: '+name);let parent=path.dirname(dest);while(parent!==target){if(fs.existsSync(parent)&&fs.lstatSync(parent).isSymbolicLink())throw Error('Target path contains a symlink: '+name);parent=path.dirname(parent);}if(fs.existsSync(dest)&&fs.lstatSync(dest).isSymbolicLink())throw Error('Target file is a symlink: '+name);}
const sourceCommit=git(source,['rev-parse','HEAD']);
console.log(JSON.stringify({mode:apply?'apply':'plan',sourceCommit,files:files.length,privateInputsPreserved:[...protectedFiles],privateNotices:notices.length}));
if(apply){
 const backup=path.join(target,'.sites-runtime','release-preserve',new Date().toISOString().replace(/[:.]/g,'-'));fs.mkdirSync(backup,{recursive:true});
 fs.writeFileSync(path.join(backup,'hosting.json'),JSON.stringify(manifest,null,2)+'\n');fs.writeFileSync(path.join(backup,'initial-history.json'),privateSeed);fs.writeFileSync(path.join(backup,'firm-adjustments.json'),JSON.stringify(notices,null,2)+'\n');
 for(const name of files){const dest=path.join(target,name);fs.mkdirSync(path.dirname(dest),{recursive:true});fs.copyFileSync(path.join(source,name),dest);}
 fs.writeFileSync(noticePath,JSON.stringify(notices,null,2)+'\n');
 if(fs.readFileSync(path.join(target,'data/initial-history.json'),'utf8')!==privateSeed||JSON.stringify(JSON.parse(fs.readFileSync(path.join(target,'.openai/hosting.json'),'utf8')))!==JSON.stringify(manifest))throw Error('Private release inputs changed unexpectedly. Do not publish.');
 fs.writeFileSync(path.join(target,'.sites-runtime','github-source-release.json'),JSON.stringify({sourceCommit,preparedAt:new Date().toISOString()},null,2)+'\n');
 console.log('Prepared owner-controlled source. Run checks and the Sites publishing workflow before any live update.');
}
