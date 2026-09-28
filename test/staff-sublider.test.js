import {test,before,beforeEach,afterEach,after} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {PGlite} from '@electric-sql/pglite';
import request from 'supertest';
import {Collection,ChannelType} from 'discord.js';
import {createApp} from '../src/app.js';
import {createBot} from '../src/bot.js';
import {allowed,hash,passwordHash} from '../src/security.js';
import {checkDatabase} from '../src/preflight.js';

const roles=['admin','sublider','moderador','recrutador'];
const ids=Object.fromEntries([...roles,'reporter','accused','bot'].map((role,index)=>[role,String(81000000000000001n+BigInt(index))]));
const config={origin:'http://localhost:3000',secret:'u'.repeat(48),production:false,botEnabled:true,divisions:[
 {id:1,guild:'10000000000000001',category:'10000000000000002',name:'Primeira'},
 {id:2,guild:'20000000000000001',category:'20000000000000002',name:'Segunda'}
]};
let db,pool,app,bot,users,network,password,sequence;
const plain=value=>value?.toJSON?.()??value;
function call(role,method,path,body){const action=request(app)[method](`/api${path}`).set('Cookie',`ifj_session=${users[role].token}`);return method==='get'?action:action.set('Origin',config.origin).set('X-CSRF-Token','csrf').send(body);}
async function session(staffId,token){await pool.query('INSERT INTO sessions(token_hash,staff_id,csrf,expires_at) VALUES($1,$2,$3,$4)',[hash(token,config.secret),staffId,'csrf',new Date(Date.now()+3600000)]);}
const memberData=number=>({name:`Pessoa ${number}`,game_nick:`Pessoa${number}`,roblox_username:`Roblox${number}`,discord_id:String(91000000000000000n+BigInt(number)),division:1});
async function report(){return (await pool.query('INSERT INTO reports(subject,reporter_id,subject_discord_id,division,reason) VALUES($1,$2,$3,1,$4) RETURNING *',['Pessoa denunciada',ids.reporter,ids.accused,'Relato para analisar.'])).rows[0];}
function warning(role){return {id:String(++sequence),commandName:'warn',guildId:config.divisions[0].guild,user:{id:ids[role]},isChatInputCommand:()=>true,isButton:()=>false,isModalSubmit:()=>false,options:{getUser:()=>({id:ids.accused,bot:false}),getString:()=>`Advertência de ${role}.`},deferReply:async function(payload){this.deferred=payload;},editReply:async function(payload){this.result=payload;}};}

function mockDiscord(){
 network={created:[],sent:[],dms:[],setup:0,channels:new Collection()};
 for(const d of config.divisions)network.channels.set(d.category,{id:d.category,guildId:d.guild,type:ChannelType.GuildCategory});
 bot.client.user={id:ids.bot};bot.client.isReady=()=>true;bot.setup=async()=>{network.setup++;};
 bot.client.guilds.fetch=async guildId=>({id:guildId,ownerId:'80000000000000999',members:{fetch:async input=>{const id=typeof input==='string'?input:input.user;return {id,user:{id,bot:false},permissions:{has:()=>false}};}},channels:{
  fetch:async id=>id?(network.channels.get(id)??null):new Collection([...network.channels].filter(([,channel])=>channel.guildId===guildId)),
  create:async options=>{const id=`3000000000000000${network.created.length+1}`,messages=new Collection();const channel={...options,id,guildId,isTextBased:()=>true,permissionOverwrites:{set:async()=>{}},messages:{fetch:async arg=>typeof arg==='object'?messages:messages.get(arg)},send:async payload=>{const message={id:`msg-${network.sent.length+1}`,author:{id:ids.bot},embeds:payload.embeds.map(plain),components:[],edit:async payload=>{message.embeds=payload.embeds.map(plain);return message;}};messages.set(message.id,message);network.sent.push(payload);return message;}};network.created.push(channel);network.channels.set(id,channel);return channel;}
 }});
 bot.client.channels.fetch=async id=>network.channels.get(id);
 bot.client.users.fetch=async id=>({id,bot:false,send:async payload=>{network.dms.push({id,payload});return {id:`dm-${network.dms.length}`};}});
}

before(async()=>{
 db=new PGlite();await db.exec(await readFile(new URL('../src/schema.sql',import.meta.url),'utf8'));password=await passwordHash('senha-segura-de-teste');
 pool={query:async(sql,args)=>{const result=await db.query(sql,args);return {...result,rowCount:result.affectedRows||result.rows.length};},connect:async()=>({...pool,release(){}})};
});
beforeEach(async()=>{
 await pool.query('TRUNCATE staff,members,reports,jobs,panels,audit RESTART IDENTITY CASCADE');users={};sequence=0;
 for(const [index,role]of roles.entries()){
  const staff=(await pool.query('INSERT INTO staff(username,password_hash,role,discord_id,discord_verified_at) VALUES($1,$2,$1,$3,now()) RETURNING id',[role,password,ids[role]])).rows[0];
  users[role]={id:staff.id,token:String(index+1).repeat(64)};await session(staff.id,users[role].token);
 }
 bot=createBot(pool,config);mockDiscord();app=createApp(pool,config,bot);
});
afterEach(async()=>{await bot.stop();});
after(async()=>{await db.close();});

test('Sub líder has the same allowed operations as admin and reads every administrative section',async()=>{
 for(const operation of ['createIFJ','deleteIFJ','editIFJ','issueCard','warn','admin','unknown'])assert.equal(allowed('sublider',operation),allowed('admin',operation),operation);
 for(const path of ['/members','/staff','/reports','/immigrations','/tickets','/ally-imports','/warnings','/operations'])await call('sublider','get',path).expect(200);
 const me=(await call('sublider','get','/me').expect(200)).body;assert.equal(me.role,'sublider');assert.equal(me.needs_discord,false);
 await call('sublider','post','/bot/setup',{}).expect(200);assert.equal(network.setup,1);
 const job=(await pool.query("INSERT INTO jobs(kind,payload,status) VALUES('test',$1,'failed') RETURNING id",['{}'])).rows[0];await call('sublider','post',`/jobs/${job.id}/retry`,{}).expect(200);assert.equal((await pool.query('SELECT status FROM jobs WHERE id=$1',[job.id])).rows[0].status,'pending');
 await call('sublider','post','/wars',{gang:'Gang de teste',reason:'Motivo informado.'}).expect(202);
});

test('administrator roles enter the panel without a Discord link while moderator and recruiter still must verify',async()=>{
 await pool.query('UPDATE staff SET discord_verified_at=NULL');
 for(const role of roles){const me=(await call(role,'get','/me').expect(200)).body;assert.equal(me.needs_discord,!['admin','sublider'].includes(role));await call(role,'get','/members').expect(['admin','sublider'].includes(role)?200:403);}
 const r=await report();await call('sublider','post',`/reports/${r.id}/tribunal`,{}).expect(409);
 const interaction=warning('sublider');await bot.handleInteraction(interaction);assert.equal((await pool.query('SELECT * FROM warnings')).rowCount,0);
});

test('Sub líder sees, edits, issues cards and deletes IFJs created by other staff, while lower roles stay scoped',async()=>{
 const a=(await call('admin','post','/members',memberData(1)).expect(201)).body;
 const m=(await call('moderador','post','/members',memberData(2)).expect(201)).body;
 const r=(await call('recrutador','post','/members',memberData(3)).expect(201)).body;
 const s=(await call('sublider','post','/members',{...memberData(4),member_rank:'Sub líder'}).expect(201)).body;
 assert.equal((await call('sublider','get','/members').expect(200)).body.length,4);assert.equal(s.created_by,users.sublider.id);
 for(const role of ['moderador','recrutador']){assert.equal((await call(role,'get','/members').expect(200)).body.length,1);await call(role,'patch',`/members/${a.id}`,{name:'Sem acesso',identity_version:1}).expect(404);await call(role,'delete',`/members/${a.id}`,{reason:'Sem acesso'}).expect(404);}
 const edited=(await call('sublider','patch',`/members/${m.id}`,{name:'Nome corrigido',member_rank:'Líder',identity_version:m.identity_version}).expect(200)).body.member;assert.equal(edited.name,'Nome corrigido');assert.equal(edited.member_rank,'Líder');
 await call('sublider','get',`/members/${a.id}/card.png`).expect(200).expect('Content-Type',/image\/png/);
 await call('sublider','delete',`/members/${r.id}`,{reason:'Cadastro duplicado',announce:true}).expect(200);assert.equal((await pool.query('SELECT * FROM members WHERE id=$1',[r.id])).rowCount,0);assert.equal((await pool.query("SELECT * FROM jobs WHERE kind='announcement'")).rowCount,1);
});

test('Sub líder creates and edits staff accounts and preserves at least one admin-level account',async()=>{
 const created=(await call('sublider','post','/staff',{username:'novo-sublider',password:'senha-forte-para-teste',role:'sublider'}).expect(201)).body;assert.equal(created.role,'sublider');
 await call('sublider','patch',`/staff/${users.recrutador.id}`,{role:'sublider',active:true}).expect(200);assert.equal((await pool.query('SELECT role FROM staff WHERE id=$1',[users.recrutador.id])).rows[0].role,'sublider');await call('recrutador','get','/me').expect(401);
 await call('sublider','patch',`/staff/${users.sublider.id}`,{role:'recrutador',active:true}).expect(400);
 await call('sublider','patch',`/staff/${users.admin.id}`,{role:'moderador',active:true}).expect(200);assert.equal((await pool.query("SELECT * FROM staff WHERE role='admin' AND active")).rowCount,0);
 await checkDatabase(pool);
 for(const role of ['moderador']){await call(role,'get','/staff').expect(403);await call(role,'post','/staff',{username:'ilegal',role:'sublider',password:'senha-forte-para-teste'}).expect(403);}
});

test('Sub líder opens a tribunal and the worker accepts its administrator identity',async()=>{
 const r=await report();const result=(await call('sublider','post',`/reports/${r.id}/tribunal`,{}).expect(202)).body;assert.equal(result.tribunal.admin_discord_id,ids.sublider);assert.equal(result.tribunal.created_by,users.sublider.id);
 await bot.work();const t=(await pool.query('SELECT * FROM tribunals WHERE report_id=$1',[r.id])).rows[0];assert.equal(t.status,'open');assert.equal(network.created.length,1);assert.equal(network.dms.length,3);
 await call('sublider','post',`/reports/${r.id}/resolve`,{resolution:'Ouvidas as duas pessoas, o caso foi encerrado.'}).expect(200);await bot.work();assert.equal((await pool.query('SELECT status FROM tribunals WHERE report_id=$1',[r.id])).rows[0].status,'closed');
});

test('verified Sub líder may warn and sees every warning, while moderators see only their own and recruiters cannot warn',async()=>{
 for(const role of ['admin','sublider','moderador']){const interaction=warning(role);await bot.handleInteraction(interaction);assert.match(interaction.result.content,/registrada/);}
 const recruiter=warning('recrutador');await bot.handleInteraction(recruiter);assert.equal((await pool.query('SELECT * FROM warnings')).rowCount,3);
 assert.equal((await call('sublider','get','/warnings').expect(200)).body.length,3);const own=(await call('moderador','get','/warnings').expect(200)).body;assert.equal(own.length,1);assert.equal(own[0].actor_id,ids.moderador);await call('recrutador','get','/warnings').expect(403);
 await pool.query('UPDATE staff SET active=false WHERE id=$1',[users.sublider.id]);await bot.handleInteraction(warning('sublider'));assert.equal((await pool.query('SELECT * FROM warnings')).rowCount,3);
});

test('tutorial completion is authenticated, requires CSRF and is allowed before mandatory Discord linking',async()=>{
 const path='/api/onboarding/complete';await request(app).post(path).set('Origin',config.origin).send({}).expect(401);
 await request(app).post(path).set('Origin',config.origin).set('Cookie',`ifj_session=${users.recrutador.token}`).send({}).expect(403);
 await pool.query('UPDATE staff SET discord_verified_at=NULL');
 for(const role of roles){assert.equal((await call(role,'get','/me').expect(200)).body.onboarding_completed,false);await call(role,'post','/onboarding/complete',{}).expect(200);assert.equal((await call(role,'get','/me').expect(200)).body.onboarding_completed,true);}
 await call('recrutador','get','/members').expect(403);
});

test('tutorial completion persists across login sessions, is idempotent, and affects only the signed-in account',async()=>{
 await call('sublider','post','/onboarding/complete',{}).expect(200);const original=new Date('2026-01-01T00:00:00.000Z');await pool.query('UPDATE staff SET onboarding_completed_at=$1 WHERE id=$2',[original,users.sublider.id]);await call('sublider','post','/onboarding/complete',{}).expect(200);
 assert.equal(new Date((await pool.query('SELECT onboarding_completed_at FROM staff WHERE id=$1',[users.sublider.id])).rows[0].onboarding_completed_at).toISOString(),original.toISOString());assert.equal((await call('admin','get','/me').expect(200)).body.onboarding_completed,false);
 await call('sublider','post','/auth/logout',{}).expect(200);const fresh=request.agent(app);await fresh.post('/api/auth/login').set('Origin',config.origin).send({username:'sublider',password:'senha-segura-de-teste'}).expect(200);const me=(await fresh.get('/api/me').expect(200)).body;assert.equal(me.onboarding_completed,true);assert.equal(me.role,'sublider');
});

test('migration accepts the new Sub líder role and preserves existing staff on repeated runs',async()=>{
 await pool.query('DELETE FROM staff WHERE id=$1',[users.sublider.id]);await pool.query('ALTER TABLE staff DROP CONSTRAINT staff_role_check');await pool.query("ALTER TABLE staff ADD CONSTRAINT staff_role_check CHECK(role IN ('admin','moderador','recrutador'))");
 const schema=await readFile(new URL('../src/schema.sql',import.meta.url),'utf8');await db.exec(schema);await pool.query("INSERT INTO staff(username,password_hash,role) VALUES('migrated-sub','not-used','sublider')");await db.exec(schema);
 assert.equal((await pool.query('SELECT * FROM staff')).rowCount,4);assert.equal((await pool.query("SELECT * FROM staff WHERE username='migrated-sub'")).rows[0].role,'sublider');
});
