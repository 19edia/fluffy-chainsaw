import {test,before,beforeEach,after} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {PGlite} from '@electric-sql/pglite';
import request from 'supertest';
import {createApp} from '../src/app.js';
import {createBot} from '../src/bot.js';
import {hash,passwordHash,passwordMatches} from '../src/security.js';

const config={origin:'http://localhost:3000',secret:'m'.repeat(48),production:false,botEnabled:true,divisions:[{id:1,guild:'10000000000000001',name:'Primeira'},{id:2,guild:'20000000000000001',name:'Segunda'}]};
const password='senha-membro-segura-123';
let db,pool,fixture,sequence=0,staff;
const post=(agent,path,body)=>agent.post('/api/member'+path).set('Origin',config.origin).send(body);
const count=async(table,memberId)=>(await pool.query(`SELECT count(*) AS total FROM ${table} WHERE member_id=$1`,[memberId])).rows[0].total;
async function member(kind='membro'){
 const index=++sequence;
 return (await pool.query('INSERT INTO members(ifj,name,game_nick,roblox_username,discord_id,division,account_kind,allied_gang,created_by) VALUES($1,$2,$3,$3,$4,1,$5,$6,$7) RETURNING *',[String(index).padStart(15,'0'),`Pessoa oficial ${index}`,`PessoaTeste${index}`,String(82000000000000000n+BigInt(index)),kind,kind==='aliado'?'Gang aliada':null,staff.id])).rows[0];
}
function start(f=fixture,overrides={}){return post(f.agent,'/register/start',{ifj:f.member.ifj,username:f.username,password,...overrides});}
function confirm(f=fixture,overrides={}){return post(f.agent,'/register/confirm',{challenge_id:f.challenge,code:f.sent.at(-1)?.code,...overrides});}
async function begin(f=fixture,overrides={}){const response=await start(f,overrides).expect(200);f.challenge=response.body.challenge_id;return response;}
async function signup(f=fixture,overrides={}){await begin(f,overrides);return confirm(f).expect(201);}
async function me(f=fixture){return (await f.agent.get('/api/member/me').expect(200)).body;}
function memberCookie(response){return response.headers['set-cookie'].find(value=>value.startsWith('ifj_member_session='));}
before(async()=>{
 db=new PGlite();await db.exec(await readFile(new URL('../src/schema.sql',import.meta.url),'utf8'));
 pool={query:async(sql,args)=>{if(typeof sql==='object'){args=sql.values;sql=sql.text;}const result=args?await db.query(sql,args):(await db.exec(sql)).at(-1);return {...result,rowCount:result.affectedRows||result.rows.length};},connect:async()=>({...pool,release(){}})};
 staff=(await pool.query("INSERT INTO staff(username,password_hash,role) VALUES('staff-admin',$1,'admin') RETURNING id",[await passwordHash('senha-admin-segura-123')])).rows[0];
});
beforeEach(async()=>{
 const record=await member();fixture={member:record,username:`membro-${record.id}`,sent:[],offline:false,dmBlocked:false};
 const f=fixture;
 f.app=createApp(pool,config,{ready:()=>!f.offline,sendMemberSignupCode:async(discordId,code,username)=>{if(f.dmBlocked)throw Error('DM indisponível');f.sent.push({discordId,code,username});}});
 f.agent=request.agent(f.app);
});
after(async()=>{await db?.close();});

test('cadastro exige IFJ existente, usuário válido e senha de ao menos doze caracteres',async()=>{
 await start(fixture,{ifj:'999999999999999'}).expect(404);
 await start(fixture,{ifj:'abc'}).expect(400);
 await start(fixture,{ifj:Number(fixture.member.ifj)}).expect(400);
 await start(fixture,{username:'usuário com espaços'}).expect(400);
 await start(fixture,{password:'12345678901'}).expect(400);
 assert.equal(fixture.sent.length,0);
 assert.equal(Number(await count('member_accounts',fixture.member.id)),0);
});

test('IFJ ainda não verificado recebe código somente no Discord registrado, sem criar conta antecipadamente',async()=>{
 const f=fixture;
 assert.equal(f.member.verified,false);
 const response=await begin(f,{discord_id:'99999999999999999',name:'Nome forjado',role:'admin'});
 assert.match(f.challenge,/^[a-f0-9]{64}$/);
 assert.equal(response.body.code,undefined);
 assert.equal(response.body.password,undefined);
 assert.deepEqual(f.sent.map(value=>value.discordId),[f.member.discord_id]);
 assert.match(f.sent[0].code,/^\d{6}$/);
 const challenge=(await pool.query('SELECT * FROM member_registration_challenges WHERE member_id=$1',[f.member.id])).rows[0];
 assert.notEqual(challenge.challenge_hash,f.challenge);
 assert.match(challenge.challenge_hash,/^[a-f0-9]{64}$/);
 assert.notEqual(challenge.code_hash,f.sent[0].code);
 assert.match(challenge.code_hash,/^[a-f0-9]{64}$/);
 assert.notEqual(challenge.password_hash,password);
 assert.equal(await passwordMatches(password,challenge.password_hash),true);
 assert.equal(Number(await count('member_accounts',f.member.id)),0);
 await f.agent.get('/api/member/me').expect(401);
});

test('confirmação cria sessão de membro protegida e usa o nome oficial do IFJ',async()=>{
 const f=fixture,response=await signup(f,{name:'Administrador falso',role:'admin'});
 assert.equal(response.body.authenticated,true);
 const cookie=memberCookie(response);
 assert.match(cookie,/HttpOnly/i);assert.match(cookie,/SameSite=Strict/i);
 assert.equal(response.headers['set-cookie'].some(value=>value.startsWith('ifj_session=')),false);
 const account=(await pool.query('SELECT * FROM member_accounts WHERE member_id=$1',[f.member.id])).rows[0];
 assert.equal(account.discord_id,f.member.discord_id);
 assert.equal(await passwordMatches(password,account.password_hash),true);
 const current=await me(f);
 assert.equal(current.name,f.member.name);assert.equal(current.username,f.username);
 assert.ok(current.csrf);assert.equal(current.password_hash,undefined);assert.equal(current.role,undefined);
 const session=(await pool.query('SELECT * FROM member_sessions WHERE account_id=$1',[account.id])).rows[0];
 const token=cookie.split(';')[0].split('=')[1];
 assert.notEqual(session.token_hash,token);assert.equal(session.token_hash,hash(token,config.secret));
 assert.equal(Number(await count('member_registration_challenges',f.member.id)),0);
 await confirm(f).expect(400);
});

test('cookie de membro nunca autoriza dados ou ações da equipe, mesmo com CSRF válido',async()=>{
 const f=fixture;await signup(f);const current=await me(f);
 for(const route of ['/api/me','/api/members','/api/staff','/api/reports','/api/warnings'])await f.agent.get(route).expect(401);
 for(const route of ['/api/staff','/api/members','/api/onboarding/complete','/api/auth/discord/start'])await f.agent.post(route).set('Origin',config.origin).set('X-CSRF-Token',current.csrf).send({username:'invasor',role:'admin',password}).expect(401);
 await f.agent.post('/api/auth/login').set('Origin',config.origin).send({username:f.username,password}).expect(401);
});

test('cookie e credenciais da equipe não se tornam uma conta de membro automaticamente',async()=>{
 const f=fixture;
 await f.agent.post('/api/auth/login').set('Origin',config.origin).send({username:'staff-admin',password:'senha-admin-segura-123'}).expect(200);
 await f.agent.get('/api/me').expect(200);
 await f.agent.get('/api/member/me').expect(401);
 await post(f.agent,'/login',{username:'staff-admin',password:'senha-admin-segura-123'}).expect(401);
});

test('nome das boas-vindas acompanha a atualização do IFJ sem aceitar nome enviado no cadastro',async()=>{
 await signup();
 await pool.query('UPDATE members SET name=$1 WHERE id=$2',['Nome atualizado pela equipe',fixture.member.id]);
 assert.equal((await me()).name,'Nome atualizado pela equipe');
});

test('aliado que possui IFJ válido também pode confirmar sua conta sem permissões de equipe',async()=>{
 fixture.member=await member('aliado');
 await signup();assert.equal((await me()).name,fixture.member.name);
 await fixture.agent.get('/api/members').expect(401);
});

test('IFJ com conta existente e nome de usuário já ocupado não criam duplicatas',async()=>{
 const f=fixture;await signup();
 await start(f,{username:'outro-usuario'}).expect(409);
 const another=await member();
 await start(f,{ifj:another.ifj,username:f.username.toUpperCase()}).expect(409);
 assert.equal(Number(await count('member_accounts',f.member.id)),1);
 assert.equal(Number(await count('member_accounts',another.id)),0);
 assert.equal(f.sent.length,1);
});

test('tentativas incorretas ficam gravadas e cinco erros bloqueiam inclusive o código correto',async()=>{
 const f=fixture;await begin();const correct=f.sent.at(-1).code;
 const wrong=correct==='111111'?'222222':'111111';
 for(let attempt=1;attempt<=5;attempt++){
  await confirm(f,{code:wrong}).expect(400);
  assert.equal((await pool.query('SELECT attempts FROM member_registration_challenges WHERE member_id=$1',[f.member.id])).rows[0].attempts,attempt);
 }
 await confirm(f,{code:correct}).expect(400);
 assert.equal(Number(await count('member_accounts',f.member.id)),0);
});

test('código vencido não cria conta nem sessão',async()=>{
 await begin();await pool.query("UPDATE member_registration_challenges SET expires_at=now()-interval '1 minute' WHERE member_id=$1",[fixture.member.id]);
 await confirm().expect(400);await fixture.agent.get('/api/member/me').expect(401);
 assert.equal(Number(await count('member_accounts',fixture.member.id)),0);
});

test('reenvio respeita um minuto e invalida o identificador do pedido anterior',async()=>{
 const f=fixture;await begin();const oldChallenge=f.challenge,oldCode=f.sent.at(-1).code;
 await start().expect(429);assert.equal(f.sent.length,1);
 await pool.query("UPDATE member_registration_challenges SET created_at=now()-interval '2 minutes' WHERE member_id=$1",[f.member.id]);
 await begin();assert.notEqual(f.challenge,oldChallenge);assert.equal(f.sent.length,2);
 await confirm(f,{challenge_id:oldChallenge,code:oldCode}).expect(400);
 await confirm().expect(201);
});

test('bot desconectado ou DM bloqueada não cria conta nem deixa código utilizável',async()=>{
 const f=fixture;f.offline=true;await start().expect(503);f.offline=false;
 f.dmBlocked=true;await start().expect(400);f.dmBlocked=false;
 assert.equal(f.sent.length,0);
 assert.equal(Number(await count('member_accounts',f.member.id)),0);
 assert.equal(Number(await count('member_registration_challenges',f.member.id)),0);
 await signup();
});

test('troca do Discord do IFJ durante cadastro impede confirmar código da identidade anterior',async()=>{
 const f=fixture;await begin();
 await pool.query('UPDATE members SET discord_id=$1 WHERE id=$2',['93939393939393939',f.member.id]);
 await confirm().expect(400);
 assert.equal(Number(await count('member_accounts',f.member.id)),0);
});

test('exclusão do IFJ durante cadastro revoga a solicitação sem criar conta',async()=>{
 const f=fixture;await begin();await pool.query('DELETE FROM members WHERE id=$1',[f.member.id]);
 await confirm().expect(400);
 assert.equal(Number(await count('member_registration_challenges',f.member.id)),0);
 assert.equal(Number(await count('member_accounts',f.member.id)),0);
});

test('login de membro valida a senha e cria nova sessão sem usar o login da equipe',async()=>{
 const f=fixture;await signup();const another=request.agent(f.app);
 await post(another,'/login',{username:f.username,password:'senha-errada-123'}).expect(401);
 await post(another,'/login',{username:'nao-existe',password}).expect(401);
 await another.get('/api/member/me').expect(401);
 const response=await post(another,'/login',{username:f.username.toUpperCase(),password}).expect(200);
 assert.ok(memberCookie(response));assert.equal((await another.get('/api/member/me').expect(200)).body.name,f.member.name);
 await another.get('/api/me').expect(401);
});

test('sessão expirada é rejeitada',async()=>{
 await signup();const account=(await pool.query('SELECT id FROM member_accounts WHERE member_id=$1',[fixture.member.id])).rows[0];
 await pool.query("UPDATE member_sessions SET expires_at=now()-interval '1 minute' WHERE account_id=$1",[account.id]);
 await fixture.agent.get('/api/member/me').expect(401);
});

test('troca de Discord após cadastro invalida sessão e impede login da identidade antiga',async()=>{
 const f=fixture;await signup();
 await pool.query('UPDATE members SET discord_id=$1 WHERE id=$2',['94949494949494949',f.member.id]);
 await f.agent.get('/api/member/me').expect(401);
 await post(request.agent(f.app),'/login',{username:f.username,password}).expect(401);
});

test('exclusão do IFJ revoga sessão e remove a conta vinculada por cascata',async()=>{
 const f=fixture;await signup();const account=(await pool.query('SELECT id FROM member_accounts WHERE member_id=$1',[f.member.id])).rows[0];
 await pool.query('DELETE FROM members WHERE id=$1',[f.member.id]);
 await f.agent.get('/api/member/me').expect(401);
 await post(request.agent(f.app),'/login',{username:f.username,password}).expect(401);
 assert.equal(Number(await count('member_accounts',f.member.id)),0);
 assert.equal((await pool.query('SELECT * FROM member_sessions WHERE account_id=$1',[account.id])).rowCount,0);
});

test('cadastro, confirmação, login e logout rejeitam origem ausente ou externa',async()=>{
 const f=fixture;
 for(const path of ['/register/start','/register/confirm','/login','/logout']){
  await f.agent.post('/api/member'+path).send({ifj:f.member.ifj,username:f.username,password}).expect(403);
  await f.agent.post('/api/member'+path).set('Origin','https://outro-site.example').send({ifj:f.member.ifj,username:f.username,password}).expect(403);
 }
 assert.equal(f.sent.length,0);
});

test('logout exige CSRF da conta de membro e revoga somente a sessão usada',async()=>{
 const f=fixture;await signup();const current=await me();
 const another=request.agent(f.app);await post(another,'/login',{username:f.username,password}).expect(200);
 await post(f.agent,'/logout',{}).expect(403);
 await f.agent.post('/api/member/logout').set('Origin',config.origin).set('X-CSRF-Token','incorreto').send({}).expect(403);
 await f.agent.get('/api/member/me').expect(200);
 await f.agent.post('/api/member/logout').set('Origin',config.origin).set('X-CSRF-Token',current.csrf).send({}).expect(200);
 await f.agent.get('/api/member/me').expect(401);
 await another.get('/api/member/me').expect(200);
});

test('troca de Discord pela equipe revoga a conta antiga e permite cadastro do novo titular do IFJ',async()=>{
 const f=fixture;await signup();const admin=request.agent(f.app);
 await admin.post('/api/auth/login').set('Origin',config.origin).send({username:'staff-admin',password:'senha-admin-segura-123'}).expect(200);
 const csrf=(await admin.get('/api/me').expect(200)).body.csrf,newDiscord='95959595959595959';
 await admin.patch(`/api/members/${f.member.id}`).set('Origin',config.origin).set('X-CSRF-Token',csrf).send({discord_id:newDiscord,identity_version:f.member.identity_version}).expect(200);
 await f.agent.get('/api/member/me').expect(401);
 assert.equal(Number(await count('member_accounts',f.member.id)),0);
 await signup();assert.equal(f.sent.at(-1).discordId,newDiscord);
 assert.equal((await me()).name,f.member.name);
});

test('conta de membro desativada perde a sessão e não consegue entrar novamente',async()=>{
 const f=fixture;await signup();await pool.query('UPDATE member_accounts SET active=FALSE WHERE member_id=$1',[f.member.id]);
 await f.agent.get('/api/member/me').expect(401);
 await post(request.agent(f.app),'/login',{username:f.username,password}).expect(401);
});

test('bot envia confirmação de cadastro de membro somente a uma conta humana presente numa divisão',async()=>{
 const f=fixture,bot=createBot(pool,config),dms=[],lookups=[];let present=false,isBot=false;
 bot.client.isReady=()=>true;
 bot.client.users.fetch=async id=>{lookups.push(id);return {bot:isBot,send:async payload=>dms.push(payload)};};
 bot.client.guilds.fetch=async()=>({members:{fetch:async({user})=>{assert.equal(user,f.member.discord_id);if(!present)throw Object.assign(Error('Membro ausente'),{code:10007});return {id:user};}}});
 try{
  await assert.rejects(bot.sendMemberSignupCode(f.member.discord_id,'123456',f.username),/Entre em uma/);assert.equal(dms.length,0);
  isBot=true;await assert.rejects(bot.sendMemberSignupCode(f.member.discord_id,'123456',f.username),/humana/);assert.equal(dms.length,0);
  isBot=false;present=true;await bot.sendMemberSignupCode(f.member.discord_id,'123456',f.username);
  assert.ok(lookups.every(id=>id===f.member.discord_id));
  const embed=dms[0].embeds[0].toJSON();
  assert.match(embed.title,/Confirme seu cadastro de membro$/);
  assert.match(embed.fields.find(field=>field.name==='Código de confirmação')?.value||'',/123456/);
  assert.equal(embed.fields.find(field=>field.name==='Login')?.value,f.username);
  assert.deepEqual(dms[0].allowedMentions,{parse:[]});
 }finally{await bot.stop();}
});
