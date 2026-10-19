import fs from 'node:fs';
import path from 'node:path';
import {execFileSync} from 'node:child_process';

const root=process.cwd(),excluded=new Set(['.git','node_modules','.sites-runtime','dist','.wrangler','.next','.vinext']);
function walk(dir){return fs.readdirSync(dir,{withFileTypes:true}).flatMap(entry=>{if(excluded.has(entry.name))return [];const file=path.join(dir,entry.name);if(entry.isSymbolicLink())return [];return entry.isDirectory()?walk(file):[path.relative(root,file)];});}
let files;try{const top=execFileSync('git',['rev-parse','--show-toplevel'],{encoding:'utf8',stdio:['ignore','pipe','ignore']}).trim();files=path.resolve(top)===root?execFileSync('git',['ls-files','-z'],{encoding:'utf8'}).split('\0').filter(Boolean):walk(root);}catch{files=walk(root);}
const failures=[];
for(const name of files){
 if(/(?:^|\/)(?:private|backups|imports)(?:\/|$)|\.(?:sqlite3?|db|csv|tsv|tradebook\.xml|pem)$/i.test(name)){failures.push(name+': private-data file type');continue;}
 if(name.endsWith('.zip'))continue; // Retained recorder source archives are inspected before initial upload.
 const file=path.join(root,name);if(!fs.existsSync(file)||fs.lstatSync(file).isSymbolicLink())continue;
 const text=fs.readFileSync(file,'utf8');
 if(/LF[EF]050[1-8]\d{6,}/.test(text))failures.push(name+': non-synthetic account identifier');
 if(/(?:gh[pousr]_[A-Za-z0-9]{25,}|github_pat_[A-Za-z0-9_]{25,}|sk-proj-[A-Za-z0-9_-]{25,}|-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----)/.test(text))failures.push(name+': credential-like content');
}
const seed=JSON.parse(fs.readFileSync('data/initial-history.json','utf8')),notices=JSON.parse(fs.readFileSync('data/firm-adjustments.json','utf8')),hosting=JSON.parse(fs.readFileSync('.openai/hosting.json','utf8'));
if(!Array.isArray(seed.accounts)||seed.accounts.length)failures.push('data/initial-history.json: public installation seed must be empty');
if(!Array.isArray(notices)||notices.length)failures.push('data/firm-adjustments.json: owner notices must stay outside GitHub');
if(hosting.project_id)failures.push('.openai/hosting.json: private deployment identity belongs in the release checkout');
if(failures.length){console.error(failures.join('\n'));process.exit(1);}
console.log('Public-source check passed: '+files.length+' files, empty install seed, no owner notices or deployment identity.');
