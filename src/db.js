import pg from 'pg';
import {readFile} from 'node:fs/promises';
import {passwordHash} from './security.js';
import {StartupError,safeFailure} from './preflight.js';
export function database(url){return new pg.Pool({connectionString:url,max:10,connectionTimeoutMillis:10000,query_timeout:15000,statement_timeout:12000});}
export async function tx(pool,fn){const c=await pool.connect();let rollbackError;try{await c.query('BEGIN');const result=await fn(c);await c.query('COMMIT');return result;}catch(e){try{await c.query('ROLLBACK');}catch(failure){rollbackError=failure;}throw e;}finally{c.release(rollbackError);}}
export async function audit(c,actor,action,detail={}){await c.query('INSERT INTO audit(actor,action,detail) VALUES($1,$2,$3)',[String(actor),action,JSON.stringify(detail)]);}
export async function enqueue(c,kind,payload){return (await c.query('INSERT INTO jobs(kind,payload) VALUES($1,$2) RETURNING id',[kind,JSON.stringify(payload)])).rows[0].id;}
export async function initialize(pool,env=process.env,{log=()=>{}}={}){
 let stage='ler schema.sql';
 const enter=label=>{stage=label;log(`Preparando: ${label}.`);};
 try{
  const schema=await readFile(new URL('./schema.sql',import.meta.url),'utf8');
  const parts=schema.split(/^-- @migration (.+)\r?$/m);
  const steps=[{label:'tabelas e índices básicos',sql:parts[0]}];
  for(let i=1;i<parts.length;i+=2)steps.push({label:parts[i].trim(),sql:parts[i+1]});
  enter('obter conexão para atualizar o banco');
  await tx(pool,async c=>{
   // The migration deadline is longer than a normal panel query. SET LOCAL
   // restores the regular limits at commit/rollback, including with a pooler.
   const query=(text,values)=>c.query({text,values,query_timeout:75000});
   enter('limites e bloqueio da atualização');
   await query("SET LOCAL lock_timeout='15s'; SET LOCAL statement_timeout='60s'");
   // Serialize initializers before any DDL or initial-admin/job checks.
   await query('SELECT pg_advisory_xact_lock($1)',[735190247]);
   for(const step of steps){enter(step.label);await query(step.sql);}
   enter('administrador inicial');
   if((await query('SELECT id FROM staff LIMIT 1')).rowCount===0){
    if(!env.INITIAL_ADMIN_USERNAME || (env.INITIAL_ADMIN_PASSWORD||'').length<12)throw new StartupError('Configure INITIAL_ADMIN_USERNAME e INITIAL_ADMIN_PASSWORD (pelo menos 12 caracteres) somente para criar o primeiro administrador.');
    await query("INSERT INTO staff(username,password_hash,role) VALUES($1,$2,'admin') ON CONFLICT(username) DO NOTHING",[env.INITIAL_ADMIN_USERNAME.toLowerCase(),await passwordHash(env.INITIAL_ADMIN_PASSWORD)]);
   }
   if(env.BOT_ENABLED!=='false'){
    enter('sincronização dos cargos existentes');
    await query("INSERT INTO jobs(kind,payload) SELECT 'sync-role',jsonb_build_object('discordId',m.discord_id) FROM members m WHERE NOT EXISTS (SELECT 1 FROM jobs j WHERE j.kind='sync-role' AND j.status='pending' AND j.payload->>'discordId'=m.discord_id)");
   }
   enter('confirmar atualização');
  });
  log('Estrutura, administrador e fila conferidos; atualização concluída.');
 }catch(error){
  const failure=new StartupError(`Banco, etapa "${stage}": ${safeFailure(error)}`);
  failure.cause=error;throw failure;
 }
}
