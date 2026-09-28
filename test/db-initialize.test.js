import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {PGlite} from '@electric-sql/pglite';
import {database,initialize,tx} from '../src/db.js';
import {passwordMatches} from '../src/security.js';
import {StartupError,safeFailure,checkDatabase} from '../src/preflight.js';

const secret='PRIVATE_PASSWORD_12345';
const adminEnv={BOT_ENABLED:'false',INITIAL_ADMIN_USERNAME:'primeiro-admin',INITIAL_ADMIN_PASSWORD:secret};
const schema=await readFile(new URL('../src/schema.sql',import.meta.url),'utf8');
async function fixture(t){
 const db=new PGlite();await db.waitReady;t.after(()=>db.close());const calls=[];
 const pool={query:async(input,args)=>{
  const config=typeof input==='string'?{text:input,values:args}:input;calls.push(config);
  const r=config.values?await db.query(config.text,config.values):(await db.exec(config.text)).at(-1);
  return {...r,rowCount:r.affectedRows||r.rows.length};
 },connect:async()=>({...pool,release(){}})};
 return {db,pool,calls};
}

test('empty database creates one usable administrator and checks the complete schema',async t=>{
 const f=await fixture(t),logs=[];await initialize(f.pool,adminEnv,{log:line=>logs.push(line)});
 const staff=(await f.pool.query('SELECT * FROM staff')).rows;
 assert.equal(staff.length,1);assert.equal(staff[0].role,'admin');assert.equal(staff[0].username,'primeiro-admin');assert.ok(await passwordMatches(secret,staff[0].password_hash));
 await checkDatabase(f.pool);assert.match(logs.join('\n'),/tribunais/);assert.match(logs.join('\n'),/patentes e boas-vindas/);assert.ok(!logs.join('\n').includes(secret));
 assert.equal((await f.pool.query('SELECT * FROM jobs')).rowCount,0);
});

test('missing first administrator rolls back all schema work and names the required variables',async t=>{
 const f=await fixture(t);await assert.rejects(initialize(f.pool,{BOT_ENABLED:'false'}),error=>error instanceof StartupError&&/administrador inicial/.test(error.message)&&/INITIAL_ADMIN_PASSWORD/.test(error.message));
 assert.equal((await f.pool.query("SELECT to_regclass('public.staff') AS staff")).rows[0].staff,null);
});

test('legacy identities, credentials and reports survive repeated migration and jobs are deduplicated',async t=>{
 const f=await fixture(t);
 // Original schema before any incremental migrations.
 await f.db.exec(schema.split('-- @migration proteção')[0]);
 await f.pool.query("INSERT INTO staff(username,password_hash,role) VALUES('existing','untouched-hash','admin')");
 await f.pool.query("INSERT INTO members(ifj,name,game_nick,roblox_username,discord_id,division,created_by) VALUES('000000000000123','Original','Nick','Roblox','12345678901234567',1,1)");
 await f.pool.query("INSERT INTO reports(member_id,subject,reporter_id,division,reason) VALUES(1,'Original','22345678901234567',1,'Motivo')");
 await initialize(f.pool,{BOT_ENABLED:'true'});await initialize(f.pool,{BOT_ENABLED:'true'});
 assert.equal((await f.pool.query('SELECT password_hash FROM staff')).rows[0].password_hash,'untouched-hash');
 const member=(await f.pool.query('SELECT * FROM members')).rows[0];assert.equal(member.ifj,'000000000000123');assert.equal(member.created_by,1);assert.equal(member.discord_id,'12345678901234567');
 assert.equal((await f.pool.query('SELECT subject_discord_id FROM reports')).rows[0].subject_discord_id,member.discord_id);
 assert.equal((await f.pool.query("SELECT * FROM jobs WHERE kind='sync-role'")).rowCount,1);
 await checkDatabase(f.pool);
});

test('invalid legacy rank produces safe SQLSTATE and exact stage without deleting existing data',async t=>{
 const f=await fixture(t);await f.db.exec(schema.split('-- @migration proteção')[0]);
 await f.pool.query('ALTER TABLE staff DROP CONSTRAINT staff_role_check');
 await f.pool.query('INSERT INTO staff(username,password_hash,role) VALUES($1,$2,$3)',['legacy',secret,'old-unknown-role']);
 let failure;await assert.rejects(initialize(f.pool,adminEnv),error=>{failure=error;return error instanceof StartupError&&/patentes e boas-vindas/.test(error.message)&&/23514/.test(error.message);});
 assert.doesNotMatch(safeFailure(failure),/PRIVATE_PASSWORD|old-unknown-role/);
 assert.equal((await f.pool.query('SELECT role FROM staff')).rows[0].role,'old-unknown-role');
 assert.equal((await f.pool.query("SELECT to_regclass('public.tribunals') AS t")).rows[0].t,null);
});

test('migration limits are scoped to the transaction and advisory lock precedes every schema change',async t=>{
 const f=await fixture(t);await f.pool.query("SET statement_timeout='12s'");await f.pool.query("SET lock_timeout='0'");await initialize(f.pool,adminEnv);
 const lock=f.calls.findIndex(q=>q.text.startsWith('SELECT pg_advisory_xact_lock'));
 const ddl=f.calls.findIndex(q=>q.text.startsWith('CREATE TABLE'));
 assert.ok(lock>0&&lock<ddl);assert.equal(f.calls[ddl].query_timeout,75000);
 assert.ok(f.calls.some(q=>q.text.includes("SET LOCAL statement_timeout='60s'")));
 assert.equal((await f.pool.query('SHOW statement_timeout')).rows[0].statement_timeout,'12s');
 assert.equal((await f.pool.query('SHOW lock_timeout')).rows[0].lock_timeout,'0');
});

test('a failed rollback cannot replace the original failure and the damaged client is discarded',async()=>{
 const original=Object.assign(new Error(secret),{code:'23514'}),rollback=new Error('Connection lost');let released,committed=false;
 const client={query:async sql=>{if(sql==='ROLLBACK')throw rollback;if(sql==='COMMIT')committed=true;},release:error=>{released=error;}};
 await assert.rejects(tx({connect:async()=>client},async()=>{throw original;}),error=>error===original);
 assert.equal(released,rollback);assert.equal(committed,false);
});

test('initialization identifies a lock timeout before applying migrations',async()=>{
 const sql=[],logs=[];const c={query:async input=>{const text=typeof input==='string'?input:input.text;sql.push(text);if(text.startsWith('SELECT pg_advisory'))throw Object.assign(new Error(secret),{code:'55P03'});},release(){}};
 await assert.rejects(initialize({connect:async()=>c},adminEnv,{log:line=>logs.push(line)}),error=>/bloqueio da atualização/.test(error.message)&&/55P03/.test(error.message)&&!error.message.includes(secret));
 assert.equal(sql.at(-1),'ROLLBACK');assert.ok(!sql.some(q=>q.startsWith('CREATE TABLE')));assert.ok(!logs.join('\n').includes(secret));
});

test('normal application queries retain their short limits',async()=>{
 const pool=database('postgresql://test:test@localhost/test');try{assert.equal(pool.options.query_timeout,15000);assert.equal(pool.options.statement_timeout,12000);}finally{await pool.end();}
});

test('SQLSTATE diagnostics cover cancellation, duplicate data and unknown codes without exposing row details',()=>{
 for(const code of ['23505','23514','23502','23503','57014','55P03','40P01','40001','42601','42710','42P07','53300','57P01','22001','XX000']){
  const result=safeFailure(Object.assign(new Error(secret),{code,detail:secret,where:secret,table:secret,constraint:secret}));assert.match(result,new RegExp(code));assert.ok(!result.includes(secret));
 }
 assert.match(safeFailure(new Error('Query read timeout')),/prazo de leitura/);
 assert.ok(!safeFailure(Object.assign(new Error(secret),{code:secret})).includes(secret));
 assert.match(safeFailure(Object.assign(new Error(secret),{code:'toString'})),/Falha no teste/);
 assert.doesNotMatch(safeFailure(Object.assign(new Error(secret),{code:40001})),/SQLSTATE|transação/);
});
