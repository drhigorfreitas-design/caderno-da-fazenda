(()=>{
const T={}, user={id:'u1'}; let session=null, cbs=[];
const tbl=n=>T[n]||(T[n]=[]);
function q(n){ let op='select', pay=null, filt=[], opt={}, ord=null;
  const run=()=>{ const rows=tbl(n);
    if(op==='select'){ let r=rows.filter(x=>filt.every(([k,v])=>x[k]===v)); return {data:r.map(x=>({...x})),error:null}; }
    if(op==='insert'){ if(rows.find(x=>x.id===pay.id&&x.owner===pay.owner)) return {error:{code:'23505',message:'dup'}}; rows.push({created_at:new Date().toISOString(),...pay}); return {error:null}; }
    if(op==='upsert'){ const key=opt.onConflict.split(','); const i=rows.findIndex(x=>key.every(k=>x[k]===pay[k])); if(i>=0) rows[i]={...rows[i],...pay}; else rows.push({created_at:new Date().toISOString(),...pay}); return {error:null}; }
    if(op==='update'){ rows.filter(x=>filt.every(([k,v])=>x[k]===v)).forEach(x=>Object.assign(x,pay)); return {error:null}; }
    if(op==='delete'){ T[n]=rows.filter(x=>!filt.every(([k,v])=>x[k]===v)); return {error:null}; } };
  const b={ select(){op='select';return b;}, insert(p){op='insert';pay=p;return b;}, upsert(p,o){op='upsert';pay=p;opt=o||{};return b;}, update(p){op='update';pay=p;return b;}, delete(){op='delete';return b;},
    eq(k,v){filt.push([k,v]);return b;}, order(){return b;}, then(res,rej){ if(!session) return Promise.resolve({data:[],error:null}).then(res,rej); try{return Promise.resolve(run()).then(res,rej);}catch(e){return Promise.reject(e).then(res,rej);} } };
  return b; }
window.__T=T;
window.supabase={createClient:()=>({
  auth:{ getSession:async()=>({data:{session}}),
    onAuthStateChange(cb){cbs.push(cb);return {data:{subscription:{unsubscribe(){}}}};},
    async signInWithPassword({email,password}){ if(password!=='segredo1') return {error:{message:'Invalid login credentials'}}; session={user,access_token:'x'}; cbs.forEach(c=>c('SIGNED_IN',session)); return {error:null}; },
    async signUp({email}){ return {data:{session:null},error:null}; },
    async signOut(){ session=null; cbs.forEach(c=>c('SIGNED_OUT',null)); return {error:null}; },
    async resetPasswordForEmail(){return {error:null};} },
  from:q, rpc:async()=>({data:null,error:{message:'sem rpc'}}) })};
})();
