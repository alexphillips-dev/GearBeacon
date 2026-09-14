import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export function buildMetadata(root, packageVersion, env = process.env) {
  const version=JSON.parse(readFileSync(join(root,'backend','package.json'),'utf8')).version;
  packageVersion=String(packageVersion || version).replace(/^v/,'');
  if (!new RegExp(`^${version.replaceAll('.','\\.')}([+-][0-9A-Za-z][0-9A-Za-z.-]*)?$`).test(packageVersion)) throw new Error('Package version must match the application version, optionally with a prerelease suffix.');
  const git = args => {
    if (!existsSync(join(root,'.git'))) return '';
    try { return execFileSync('git',args,{cwd:root,encoding:'utf8',timeout:2000,windowsHide:true,stdio:['ignore','pipe','ignore']}).trim(); }
    catch { return ''; }
  };
  const explicit=String(env.GEARBEACON_BUILD_BRANCH || '');
  if (explicit && !['main','dev'].includes(explicit)) throw new Error('Build branch must be main or dev.');
  const ref=String(env.GITHUB_HEAD_REF || env.GITHUB_REF || git(['symbolic-ref','--short','HEAD'])).replace(/^refs\/heads\//,'');
  const branch=explicit || (packageVersion.split('+')[0].includes('-') ? 'dev' : ['main','dev'].includes(ref) ? ref : 'main');
  const commit=env.GEARBEACON_BUILD_COMMIT || env.GITHUB_SHA || git(['rev-parse','HEAD']);
  return {name:'GearBeacon',version,packageVersion,branch,commit:/^[a-f0-9]{40}$/i.test(commit) ? commit.toLowerCase() : null,builtAt:new Date().toISOString()};
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const root=resolve(import.meta.dirname,'..');
  const destination=resolve(process.argv[2] || root);
  writeFileSync(join(destination,'build-info.json'),JSON.stringify(buildMetadata(root,process.argv[3] || process.env.GEARBEACON_PACKAGE_VERSION),null,2)+'\n');
}
