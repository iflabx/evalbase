import http from 'node:http';
import {existsSync} from 'node:fs';
import {writeFile} from 'node:fs/promises';
import {assert,readFixture,login,request,projectPath,evidence,base,setPhase} from './common.mjs';

const guard=()=>assert(!existsSync(evidence+'/STOP.json'),'safety_stop');
guard();
const f=await readFixture(),admin=await login('admin');
setPhase('isolated-oversize-reproduction');
const before=(await request(admin,'GET',projectPath(f)+'/collaborative-draft-source-files')).json().total;
const started=performance.now();
guard();
const result=await new Promise(resolve=>{
  let settled=false;
  const finish=value=>{if(!settled){settled=true;resolve(value);}};
  const req=http.request(new URL(base+projectPath(f)+'/pending-uploads'),{
    method:'POST',headers:{...admin,origin:'http://127.0.0.1:4240','content-type':'text/csv','content-length':'50000001','x-file-name':'oversize-native-diagnostic.csv'},
  },response=>{
    let bytes=0;response.on('data',chunk=>bytes+=chunk.length);
    response.on('end',()=>finish({status:response.statusCode,responseBytes:bytes,complete:response.complete}));
    response.on('error',error=>finish({status:response.statusCode,error:error.code??error.name,complete:response.complete}));
  });
  req.setTimeout(15000,()=>req.destroy(Object.assign(new Error('timeout'),{code:'diagnostic_timeout'})));
  req.on('error',error=>finish({status:0,error:error.code??error.name}));
  req.end(Buffer.alloc(50000001,120));
});
result.ms=performance.now()-started;
result.sourceFilesBefore=before;
result.sourceFilesAfter=(await request(admin,'GET',projectPath(f)+'/collaborative-draft-source-files')).json().total;
await writeFile(evidence+'/oversize-diagnostic-result.json',JSON.stringify(result,null,2));
console.log(JSON.stringify(result));
