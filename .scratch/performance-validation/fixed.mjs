import {appendFile,writeFile,access} from 'node:fs/promises';
import {assert,delay,evidence,request,login,readFixture,projectPath,draftPath,versionPath,snapshot,setPhase} from './common.mjs';
const f=await readFixture();
const stopped=()=>access(`${evidence}/STOP.json`).then(()=>true,()=>false);
try {
  for(const users of [2,3]) {
    assert(!await stopped(),'safety_stop');
    const sessions=await Promise.all(['admin','editor','viewer'].slice(0,users).map(login));
    const queues=sessions.map(()=>Promise.resolve());
    const start=performance.now(),seconds=180,total=users*seconds;
    let failed=false;
    setPhase(`fixed-arrival-${users}`);
    for(let n=0;n<total&&!failed;n++) {
      const planned=start+n*1000/users,index=n%users;
      await delay(Math.max(0,planned-performance.now()));
      if(await stopped()){failed=true;break;}
      queues[index]=queues[index].then(async()=>{
        if(failed||await stopped()){
          failed=true;
          await appendFile(`${evidence}/fixed-arrivals.jsonl`,JSON.stringify({users,plannedOffsetMs:planned-start,waitMs:performance.now()-planned,totalMs:performance.now()-planned,status:'cancelled'})+'\n');
          return;
        }
        const began=performance.now();
        try {
          if(index<2&&Math.floor(n/users)%4===0) {
            const row=(await snapshot(sessions[index],f)).records[index];
            await request(sessions[index],'PATCH',draftPath(f)+`/records/${row.id}`,{field:'expectedOutput',value:`固定到达-${users}-${n}`,expectedFieldRevision:row.expectedOutputRevision},{label:'fixed-autosave'});
          } else await request(sessions[index],'GET',versionPath(f)+'/records?limit=20',undefined,{label:'fixed-read'});
          await appendFile(`${evidence}/fixed-arrivals.jsonl`,JSON.stringify({users,plannedOffsetMs:planned-start,waitMs:began-planned,responseMs:performance.now()-began,totalMs:performance.now()-planned,status:'passed'})+'\n');
        } catch(error) {
          failed=true;
          await appendFile(`${evidence}/fixed-arrivals.jsonl`,JSON.stringify({users,plannedOffsetMs:planned-start,waitMs:began-planned,responseMs:performance.now()-began,totalMs:performance.now()-planned,status:'failed',error:error.message})+'\n');
        }
      });
      await appendFile(`${evidence}/fixed-scheduled.jsonl`,JSON.stringify({users,plannedOffsetMs:planned-start})+'\n');
    }
    await Promise.all(queues);assert(!failed);
  }
  await writeFile(`${evidence}/fixed-complete`,'passed');
} catch(error) {await writeFile(`${evidence}/fixed-failure.json`,JSON.stringify({error:error.message}));process.exitCode=1;}
